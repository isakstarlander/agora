# Next Steps

Manual actions required before the project can run and be verified.

---

## 1 — Install Node 24 LTS (if not already active)

```bash
nvm install 24 --lts
nvm use 24
```

---

## 2 — Create Supabase project (product request 02)

1. Go to <https://supabase.com> → New project.
2. Note the **Project URL** and **anon key** from *Project Settings → API*.
3. Note the **service role key** from the same page (keep secret).

---

## 3 — Create Upstash Redis instance

1. Go to <https://console.upstash.com> → Create Database → Region: EU.
2. Note the **REST URL** and **REST token**.

---

## 4 — Obtain Anthropic API key

1. Go to <https://console.anthropic.com> → API Keys → Create key.

---

## 5 — Populate `.env.local`

```bash
cp .env.example .env.local
```

Fill in these **required** values (the app will not start without them):

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project-id>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
ANTHROPIC_API_KEY=sk-ant-...
UPSTASH_REDIS_REST_URL=https://...upstash.io
UPSTASH_REDIS_REST_TOKEN=...
AGORA_INTERNAL_API_KEY=agora_<43-base64url-chars>   # generate a placeholder for now
```

For `AGORA_INTERNAL_API_KEY` during development, any `agora_`-prefixed string of the correct
length works. The real key is created in product request 04 (`api-first/04-api-keys.md`).

The remaining variables (`POSTHOG_*`, `SENTRY_*`, `MANIFESTO_API_KEY`, `DEEPL_API_KEY`)
are optional for initial local development.

---

## 6 — Start dev server

```bash
source ~/.nvm/nvm.sh && nvm use 24
npm install          # from repo root
npm run dev
```

Open <http://localhost:3000> — expect a page with a centred "Agora" heading.

---

## 7 — Verify

```bash
npm run typecheck    # must exit 0
npm run lint         # must exit 0
```

---

## 8 — Run database migrations (product request 02)

Once the Supabase project exists, apply migrations from `packages/db/migrations/`
using the Supabase CLI or the dashboard SQL editor. This is covered in `api-first/02-database.md`.

---

## What is already done

- Monorepo scaffold at `~/git/agora/` with npm workspaces + Turborepo
- Next.js 16 app, all dependencies installed, shadcn/ui initialised
- `lib/api/` — response envelope, CORS, pagination, error handling
- `lib/env.ts` — environment schema (will validate at startup)
- CI workflow at `.github/workflows/ci.yml`
- See `docs/rfc-01-scaffold.md` for the full implementation record.
