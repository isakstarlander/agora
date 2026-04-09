# RFC-01 — Monorepo Scaffold & Configuration

| Field       | Value                               |
|-------------|-------------------------------------|
| Status      | Implemented                         |
| Date        | 2026-04-09                          |
| Author      | GitHub Copilot                      |
| Spec        | `api-first/01-scaffold.md` + `1-scaffold-and-config.md` |
| Commit      | `0abebc6` / `eae0c4a`              |

---

## Summary

Bootstrapped the Agora monorepo at `~/git/agora/` using npm workspaces and Turborepo.
The repository contains a Next.js 16 web application, a shared database types package,
and a scripts package. The API infrastructure layer (`lib/api/`) specified by
`api-first/01-scaffold.md` is fully in place. All files typecheck cleanly.

---

## Motivation

Product requests 02–09 all depend on a correctly wired monorepo: typed Supabase clients,
a standard API response envelope, CORS handling, pagination helpers, and the OpenAPI
registry infrastructure. This RFC documents what was created so each subsequent request
has an accurate baseline to build on.

---

## Decisions

### Node version
The spec requires Node ≥ 24 LTS. The system had Node 22 (active) and lacked 24.
`nvm install 24 --lts` was used to install Node **v24.14.1** / npm **11.11.0**.
A `packageManager` field was added to the root `package.json` to satisfy Turborepo 2.x's
workspace resolution requirement.

### shadcn/ui `toast` component
The spec lists `toast` as a component to add. shadcn@4 marks `toast` as deprecated in
favour of `sonner`. `sonner` was installed instead; `toast` was not added.

### Zod v4 API change
`api-first/01-scaffold.md` references `e.errors[0]` on a ZodError in `lib/api/handler.ts`.
Zod v4 (installed: **4.3.6**) renamed this property to `e.issues`. The implementation
uses `e.issues` to match the installed version.

### CORS `Allow-Headers`
`api-first/01-scaffold.md` specifies `'Content-Type'` only. `api-first/foundation.md §9`
specifies `'Content-Type, Authorization'` — required because `/api/v1/accountability`
is gated behind `Authorization: Bearer agora_...`. The foundation governs; `Authorization`
is included.

### `AGORA_INTERNAL_API_KEY` in `lib/env.ts`
The root scaffold spec (`1-scaffold-and-config.md`) does not mention this variable.
`api-first/foundation.md §11` requires it (server-only, used by the Löfteskollen demo).
It was added to the `server` schema in `lib/env.ts` with a `z.string().startsWith('agora_')`
validator and included in `.env.example` with a note that it must never be committed.

### Nested `.git` in `apps/web`
`create-next-app` initialised its own git repository inside `apps/web/`. This would have
made the directory appear as an untracked submodule. The nested `.git` was removed and
`apps/web/` committed as ordinary tracked files in the monorepo root.

---

## Repository Structure Created

```
~/git/agora/
├── .env.example
├── .gitignore
├── .github/
│   └── workflows/
│       └── ci.yml                  ← lint + typecheck on PR/push to main
├── package.json                    ← npm workspaces root, packageManager field
├── turbo.json
├── docs/
│   └── rfc-01-scaffold.md         ← this file
├── apps/
│   └── web/                        ← @agora/web
│       ├── app/
│       │   ├── layout.tsx          ← root layout, lang="sv"
│       │   ├── page.tsx            ← placeholder "Agora" heading
│       │   └── globals.css
│       ├── components/
│       │   └── ui/                 ← 19 shadcn/ui components
│       ├── lib/
│       │   ├── api/
│       │   │   ├── cors.ts         ← CORS_HEADERS, handleOptions, withCors
│       │   │   ├── response.ts     ← ok, paginated, err, notFound, badRequest, rateLimited, internalError
│       │   │   ├── pagination.ts   ← PaginationSchema, paginate, parsePagination
│       │   │   ├── errors.ts       ← ApiRequestError, NotFoundError, ValidationError
│       │   │   └── handler.ts      ← apiRoute wrapper (catches ApiRequestError + ZodError)
│       │   ├── supabase/
│       │   │   ├── client.ts       ← browser client (anon key)
│       │   │   └── server.ts       ← server client + service role client
│       │   ├── env.ts              ← t3-env/Zod schema for all env vars
│       │   └── utils.ts            ← cn, PARTY_COLORS, PARTY_NAMES, DOCUMENT_TYPE_LABELS, getCurrentRm
│       ├── next.config.ts          ← security headers, image remotePatterns
│       ├── tsconfig.json           ← strict, noUncheckedIndexedAccess, ES2022
│       └── package.json            ← @agora/web
├── packages/
│   └── db/
│       ├── migrations/             ← empty, populated in RFC-02
│       ├── src/
│       │   ├── index.ts            ← re-exports Database type
│       │   └── database.types.ts   ← placeholder (replaced by supabase CLI)
│       ├── package.json            ← @agora/db
│       └── tsconfig.json
└── scripts/
    ├── ingest/
    │   ├── riksdagen.ts            ← placeholder (RFC-03)
    │   ├── esv.ts                  ← placeholder (RFC-04)
    │   └── manifesto.ts            ← placeholder (RFC-04)
    ├── embed/
    │   └── generate-embeddings.ts  ← placeholder (RFC-03)
    ├── package.json                ← @agora/scripts
    └── tsconfig.json
```

---

## Key Package Versions

| Package | Version installed |
|---|---|
| `next` | 16.2.3 |
| `react` / `react-dom` | 19.2.4 |
| `typescript` | ^5 |
| `tailwindcss` | ^4 |
| `zod` | 4.3.6 |
| `@supabase/supabase-js` | ^2.102.1 |
| `@supabase/ssr` | ^0.10.0 |
| `ai` (Vercel AI SDK) | ^6.0.154 |
| `@ai-sdk/anthropic` | ^3.0.68 |
| `@upstash/ratelimit` | ^2.0.8 |
| `@upstash/redis` | ^1.37.0 |
| `@asteasolutions/zod-to-openapi` | ^8.5.0 |
| `swagger-ui-react` | ^5.32.2 |
| `next-intl` | ^4.9.0 |
| `posthog-js` | ^1.365.5 |
| `posthog-node` | ^5.29.2 |
| `@sentry/nextjs` | ^10.47.0 |
| `@t3-oss/env-nextjs` | ^0.13.11 |
| `shadcn` (CLI) | 4.2.0 |
| `turbo` | 2.9.5 |
| Node.js | v24.14.1 |
| npm | 11.11.0 |

---

## What This RFC Does NOT Cover

The following are out of scope for RFC-01 and are implemented in subsequent requests:

- Database migrations (`packages/db/migrations/`) — RFC-02
- Riksdagen ingestion script — RFC-03
- ESV / Manifesto ingestion scripts — RFC-04
- i18n (`next-intl` routing, `messages/sv.json`, `messages/en.json`) — RFC-06
- OpenAPI registry (`lib/api/openapi/`) — RFC-08 onwards
- Rate limiting middleware (`apps/web/middleware.ts`) — RFC-11 (api-first/04)
- API key system (`api_keys` table, `POST /api/v1/keys/request`) — RFC-11 (api-first/04)
- Actual API route handlers — RFC-05 onwards
- Löfteskollen demo page (`app/[locale]/demo/`) — RFC-09 (api-first/09)

---

## Verification Status

| Check | Result |
|---|---|
| `npx tsc --noEmit` in `apps/web/` | ✅ exits 0 |
| `npm run typecheck` (turbo) | ✅ exits 0 |
| No nested `.git` in `apps/web/` | ✅ confirmed |
| `lib/api/` files compile | ✅ confirmed |
| `npm run dev` (requires `.env.local`) | ⚠️ pending — see `NEXT_STEPS.md` |
