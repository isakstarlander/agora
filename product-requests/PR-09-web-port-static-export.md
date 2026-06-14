# PR-09 — Port Next.js dashboard to static export

## Outcome

A new top-level `web/` directory containing a port of `../agora/agora/apps/web` with the following changes: static-export build (`output: 'export'`, `images.unoptimized: true`); all data fetching swapped from `@supabase/supabase-js` calls to `fetch('/v1/...')` against the API Gateway URL from PR-08; `posthog-js`, `@sentry/nextjs`, and the `/admin` + `/api-keys` routes removed; `next-intl` routing (Swedish primary, English best-effort) preserved. At the end of this PR `npm run build` produces `./web/out/` — a directory ready for PR-10 to upload to S3.

## Roadmap anchor

`11-roadmap.md` — Phase 3, steps 1–5 (port half); `07-dashboard.md`.

## Prerequisites

- PR-08 (the API is reachable at an `execute-api` URL so the dev build can talk to it).

## Context

The existing implementation lives at `../agora/agora/apps/web` and is a **working** Next.js 16 App Router app with:

- `next-intl` — bilingual routing (`sv`, `en`) via `[locale]` URL segment. Swedish-primary.
- shadcn/ui + Radix + Tailwind 4 — component library.
- Recharts + Lucide icons.
- `@supabase/supabase-js` data fetching from client components.
- `posthog-js` for analytics; `@sentry/nextjs` for errors.
- `/admin` and `/api-keys` routes for the (now-removed) API-key self-service product.
- Pages roughly matching the inventory in `07-dashboard.md` §3.

We **keep** the UI code and **replace the substrate**. Specifically, this PR:

1. Copies the app to `web/` as a fresh Next.js project (not a workspace member — CDK deploys from here directly).
2. Swaps data fetching from Supabase to the new HTTP API.
3. Strips the Vercel / PostHog / Sentry / API-key concerns.
4. Produces a static export.

The result is a directory that works identically in dev (`npm run dev`) and prod (S3+CloudFront in PR-10).

## Scope / Deliverables

### 1. Create `web/`

At the repo root, create a new `web/` directory. Do **not** add it to the `../agora/` (existing) workspace — it is its own npm project.

Copy the relevant subtree from `../agora/agora/apps/web`:

- `app/`, `components/`, `lib/`, `messages/` (translation JSON), `public/`, `next-intl.config.ts`, `tailwind.config.ts`, `tsconfig.json`.
- Do **not** copy `next.config.ts` verbatim — we rewrite it in step 2.
- Do **not** copy `package.json` verbatim — we curate dependencies in step 3.

### 2. `web/next.config.ts`

```ts
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin();

export default withNextIntl({
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,       // pleasant for S3 static hosting
  experimental: {
    // No server actions — this is a static site.
  },
});
```

`trailingSlash: true` means `s3://agora-web/ledamoter/index.html` is reachable as `/ledamoter/`, which CloudFront's default root-object behaviour handles cleanly.

### 3. `web/package.json`

```json
{
  "name": "@agora/web",
  "private": true,
  "scripts": {
    "dev":  "next dev -p 3000",
    "build":"next build",
    "start":"next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "next": "^16",
    "react": "^19",
    "react-dom": "^19",
    "next-intl": "^4",
    "lucide-react": "^0.383",
    "recharts": "^2",
    "@radix-ui/react-dialog": "^1",
    "@radix-ui/react-dropdown-menu": "^2",
    "@radix-ui/react-popover": "^1",
    "class-variance-authority": "^0.7",
    "clsx": "^2",
    "tailwind-merge": "^2"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@types/react": "^19",
    "autoprefixer": "^10",
    "eslint": "^9",
    "eslint-config-next": "^16",
    "postcss": "^8",
    "prettier": "^3",
    "tailwindcss": "^4",
    "typescript": "^5"
  }
}
```

**Removed** relative to the existing implementation:

- `@supabase/supabase-js`
- `@supabase/ssr`
- `posthog-js`, `posthog-node`
- `@sentry/nextjs`, `@sentry/node`
- Any Vercel-specific packages (`@vercel/analytics`, `@vercel/blob`)
- The Upstash client (if present): `@upstash/redis`, `@upstash/ratelimit`

### 4. Swap the data layer

The existing implementation reads data through helper modules under `lib/data/` and `lib/supabase/`. Replace them with one module:

```
web/lib/api.ts
```

```ts
const API_BASE = process.env.NEXT_PUBLIC_API_BASE!;

export type Envelope<T> = {
  items: T[];
  next_cursor: string | null;
  fetched_at: string;
  source: string;
};

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { signal, cache: 'no-store' });
  if (!res.ok) {
    const problem = await res.json().catch(() => null);
    throw new ApiError(res.status, problem?.detail ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  // similar
}
```

Then replace every `supabase.from(...).select(...)` call with the appropriate `apiGet('/v1/...')`. This is the biggest mechanical change. A grep over the ported code for `@supabase/supabase-js` and for `createClient(` finds the sites; each should map to one helper function in `lib/api.ts`.

The call sites are concentrated (per the upstream RFCs in `../agora/agora/docs/`) in:

- `components/party-cohesion-chart.tsx` → `apiGet<Envelope<Cohesion>>('/v1/party-cohesion?rm=...')`
- `components/attendance-chart.tsx` → `.../v1/members/{iid}/attendance`
- `components/votes-table.tsx` → `.../v1/votes?...`
- `components/motions-table.tsx` → `.../v1/documents?doktyp=mot&...`
- `components/budget-area-chart.tsx` → `.../v1/budget?...`
- etc.

Keep types in `web/lib/types.ts` — port straight from the existing `packages/db/src/database.types.ts` where practical (same schema, same shapes).

### 5. Remove dashboards for cut features

Delete:

- `web/app/[locale]/admin/` — the API-key admin UI.
- `web/app/[locale]/api-keys/` or `web/app/[locale]/dev/` — whatever the existing implementation named the self-service keys page.
- `web/app/api/` — Next API routes. The new API lives in API Gateway, not in Next's server runtime.

Keep:

- The accountability demo page at `/[locale]/ansvar` — now pointed at the live `/v1/accountability` endpoint (which returns 501 until PR-14; the UI handles the error gracefully and shows a "kommer snart" message until that day).
- `/[locale]/sok` — hybrid search, same treatment (501 → "kommer snart" until PR-13).

### 6. Methodology pages

Create (or port) the three first-class methodology pages listed in `07-dashboard.md` §3:

- `/[locale]/metodik/sammanfattning`
- `/[locale]/metodik/ansvarsutkravande`
- `/[locale]/metodik/sokning`

Content placeholder: Swedish-language stubs reading "Metodik publiceras i samband med lansering av funktionen." PR-13 and PR-14 fill in the actual prompt content when the features ship.

### 7. Environment variables

`web/.env.example`:

```
NEXT_PUBLIC_API_BASE=https://<api-gateway-execute-api-url>/v1
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

For the production build PR-10 will inject `NEXT_PUBLIC_API_BASE=https://<cloudfront-domain>/v1` so that browser requests stay same-origin (no CORS preflight).

### 8. Footer attribution

Verify or add the footer text from `03-data-sources.md` §1.2: the three required attributions (Sveriges riksdag, Statskontoret, Manifesto Project) plus the "not affiliated" disclaimer. The text is Swedish; English fallback is identical wording in English.

### 9. Source-of-truth invariants

The invariants from `07-dashboard.md` §9 must be enforced:

- **No claim without a source.** Every rendered fact either shows a `source_url` link or is derived from facts on the same page that do.
- **AI chip + timestamp + model + prompt link** on every LLM-generated block (once PR-13/14 land; add the components now with a placeholder).
- **`Rapportera` mailto link** on every generated block: `mailto:rapportera@<domain>?subject=AI-fel i Agora&body=%5Bdok_id%3A%20...%5D%20...`.
- **No infinite scroll.** Pagination uses explicit Next/Previous and URL-encodes the cursor.
- **No local storage**; no cookies beyond strictly-necessary (none).

### 10. Build & local dev

```bash
cd web
cp .env.example .env.local
# edit .env.local → NEXT_PUBLIC_API_BASE=<api-gateway-url>
npm ci
npm run dev         # http://localhost:3000
npm run build       # produces ./out/
npm run typecheck   # must be clean
```

### 11. Asset budget

Per-page JS bundle target <200 KB gzipped (see `07-dashboard.md` §8). Measure with `next build --profile`. If any page exceeds, defer heavy imports with `dynamic()`.

## Manual steps

1. Copy-paste the source. No automated codemod is provided; a careful port with grep + replace is the expected path. Budget: 2–3 days of focused work by someone fluent in the existing codebase.
2. Run `npm run build` locally and open `./out/index.html` in a browser to verify the static export is usable without a server.

## Acceptance criteria

- [ ] `web/` exists; `web/package.json` lists no Supabase / Vercel / PostHog / Sentry / Upstash deps.
- [ ] `npm ci && npm run typecheck && npm run lint && npm run build` all succeed from a clean checkout.
- [ ] `web/out/` contains static HTML for the core routes: `/`, `/sv/`, `/sv/ledamoter/`, `/sv/motioner/`, `/sv/voteringar/`, `/sv/budget/`, `/sv/ansvar/`, `/sv/sok/`, `/sv/om/`, `/sv/metodik/`.
- [ ] Opening any of the above HTML files via a static server (e.g. `npx serve web/out`) renders the page and makes a network call to `process.env.NEXT_PUBLIC_API_BASE` that returns real data.
- [ ] The `/sv/ansvar/` page degrades gracefully (shows "kommer snart") when `POST /v1/accountability` returns 501. Same for `/sv/sok/`.
- [ ] Footer attributes the three data sources per `03-data-sources.md` §1.2.
- [ ] No `/admin` or `/api-keys` URLs resolve.
- [ ] Accessibility audit (`npx pa11y http://localhost:3000/sv/`) reports zero serious issues.

## Out of scope

- Hosting / CloudFront / WAF / certs. PR-10.
- Rewiring the summary, search, and accountability UIs to live endpoints. PR-13, PR-14 will re-touch the corresponding components to switch from "kommer snart" to live.
- Adding new dashboard pages beyond the inventory in `07-dashboard.md` §3.
- A dev/ page for key management. That is PR-17 (Phase 9), optional.
- A UI rewrite to SvelteKit. Explicitly rejected in `07-dashboard.md` §1.
