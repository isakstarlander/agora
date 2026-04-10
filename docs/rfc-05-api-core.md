# RFC-05 — Core API Routes

| Field  | Value |
|--------|-------|
| Status | Implemented |
| Date   | 2026-04-10 |
| Author | GitHub Copilot |
| Spec   | `api-first/05-api-core.md` |

---

## Summary

Implemented twelve read endpoints across five resource groups: members, documents,
votes, budget, and parties. Every handler follows the same pattern — Zod-validated
query params, explicit-column Supabase query, and a response via the `ok()` /
`paginated()` envelope helpers. The members list additionally registers its
request/response schema in the OpenAPI registry. `tsc --noEmit` exits clean.

---

## Motivation

These are the foundational read endpoints the rest of the API surface depends on.
The accountability endpoint (PR-07) cross-references members, documents, and votes;
the Löfteskollen demo (PR-10) calls members and parties; the search endpoints (PR-06)
are scoped by document type and riksmöte. None of those features can be built before
these single-source endpoints exist.

---

## Decisions

### OpenAPI registry already existed (step 1 no-op)

The spec opens with "Create `lib/api/openapi/registry.ts`". This file was created in
PR-04 with identical content. The step was skipped; the existing singleton was imported
as-is.

### `ZodError.issues` instead of `.errors`

The spec samples use `parsed.error.errors[0]?.message` in `budget/route.ts`. The
project uses Zod v4, which renamed the property from `.errors` to `.issues`. The
implementation uses `.issues[0]?.message` throughout.

### Dynamic segment params cast to `string`

Next.js types `params` as `Promise<Record<string, string | undefined>>` when
`noUncheckedIndexedAccess` is enabled (as it is in this project's `tsconfig.json`).
The spec's destructuring `const { id } = await ctx.params` therefore yields
`string | undefined`, which Supabase's `.eq()` rejects as a type error. All dynamic
segment reads use an explicit cast:

```typescript
const id = (await ctx.params).id as string
```

This is safe because Next.js guarantees the segment is present whenever the route
matches.

---

## Files Created

| File | Description |
|---|---|
| `apps/web/app/api/v1/members/route.ts` | `GET /api/v1/members` — list with `party` / `status` filters and OpenAPI schema registration |
| `apps/web/app/api/v1/members/[id]/route.ts` | `GET /api/v1/members/:id` — full member profile |
| `apps/web/app/api/v1/members/[id]/votes/route.ts` | `GET /api/v1/members/:id/votes` — paginated vote results joined to votes |
| `apps/web/app/api/v1/members/[id]/documents/route.ts` | `GET /api/v1/members/:id/documents` — documents via `document_authors` join |
| `apps/web/app/api/v1/documents/route.ts` | `GET /api/v1/documents` — list with `type`, `rm`, `committee`, `party` filters |
| `apps/web/app/api/v1/documents/[id]/route.ts` | `GET /api/v1/documents/:id` — full document with nested `document_texts` and `document_authors` |
| `apps/web/app/api/v1/votes/route.ts` | `GET /api/v1/votes` — list with `rm` filter |
| `apps/web/app/api/v1/votes/[id]/route.ts` | `GET /api/v1/votes/:id` — vote detail with `results_by_party` aggregation |
| `apps/web/app/api/v1/budget/route.ts` | `GET /api/v1/budget` — ESV rows with `year`, `expenditure_area_code`, `budget_type` filters |
| `apps/web/app/api/v1/budget/areas/route.ts` | `GET /api/v1/budget/areas` — deduplicated expenditure area list |
| `apps/web/app/api/v1/parties/route.ts` | `GET /api/v1/parties` — static list from `PARTY_NAMES` + `PARTY_COLORS` |
| `apps/web/app/api/v1/parties/[party]/votes/route.ts` | `GET /api/v1/parties/:party/votes` — rolled-up majority position per vote |

---

## Architecture

All routes share the same three-layer structure:

```
Request
  │
  ├── apiRoute()           — catches ZodError + ApiRequestError, handles OPTIONS preflight
  │
  ├── parsePagination()    — extracts page + per_page from URLSearchParams (defaults: 1, 20)
  ├── paginate()           — returns { from, to } range for Supabase .range()
  │
  ├── createClient()       — anon/publishable-key Supabase client (all data is publicly readable)
  ├── supabase.from(...)   — explicit column select, filters applied conditionally
  │
  └── ok() / paginated()   — stamps CORS headers + generated_at, returns NextResponse
```

Notable per-endpoint patterns:

**`GET /api/v1/documents?party=X`** — multi-step subquery: members → document_authors → documents.
Returns empty pages early if either intermediate query yields no rows, avoiding an `IN ()`
with an empty list.

**`GET /api/v1/votes/:id`** — parallel `Promise.all` for vote metadata and vote_results rows.
Results are aggregated in-memory into a `results_by_party` map keyed by party code:
`{ ja, nej, avstar, franvaro }`.

**`GET /api/v1/parties/:party/votes`** — rolls up individual `vote_results` rows into a
majority position (`party_position: 'Ja' | 'Nej'`) per `vote_id`. The Supabase query
fetches all rows in the requested page window; the rollup happens in-memory over that
window. The `count` used for the pagination envelope is the raw `vote_results` row count,
not the deduplicated vote count — consistent with how the cursor is consumed by the client.

---

## Verification

```bash
# Members
curl 'http://localhost:3000/api/v1/members?party=S&per_page=5'
curl 'http://localhost:3000/api/v1/members/{id}'
curl 'http://localhost:3000/api/v1/members/{id}/votes'
curl 'http://localhost:3000/api/v1/members/{id}/documents'

# Documents
curl 'http://localhost:3000/api/v1/documents?type=mot&rm=2024/25'
curl 'http://localhost:3000/api/v1/documents/{id}'

# Votes
curl 'http://localhost:3000/api/v1/votes?rm=2024/25'
curl 'http://localhost:3000/api/v1/votes/{id}'

# Budget
curl 'http://localhost:3000/api/v1/budget?year=2024&budget_type=utfall'
curl 'http://localhost:3000/api/v1/budget/areas'

# Parties
curl 'http://localhost:3000/api/v1/parties'
curl 'http://localhost:3000/api/v1/parties/S/votes'
```

All responses include `generated_at` in `meta` and `Access-Control-Allow-Origin: *`.

---

## Next Steps (PR-06+)

- `GET /api/v1/search` and `GET /api/v1/search/manifesto` — hybrid FTS + vector search
  (PR-06); depends on `document_chunks` embeddings from the embed script
- `GET /api/v1/accountability` — gated behind `requireApiKey()` from PR-04; calls
  Claude Haiku + Sonnet; patterned on the member + document + vote endpoints built here
- `GET /api/v1/parties/:party/route.ts` — party detail page (not in PR-05 spec; add
  when the Löfteskollen demo (PR-10) requires it)
- Wire `checkRateLimit()` into `apps/web/middleware.ts` — the public read endpoints
  created here are the first routes that need edge-layer rate limiting
- Expand OpenAPI `registry.registerPath()` to cover all twelve routes (PR-08, `/docs`)
