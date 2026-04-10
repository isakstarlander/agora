# RFC-09 — Löfteskollen Demo Page

| Field  | Value |
|--------|-------|
| Status | Implemented |
| Date   | 2026-04-10 |
| Author | GitHub Copilot |
| Spec   | `api-first/09-demo-lofteskollen.md` |

---

## Summary

Shipped the Löfteskollen demo page at `/sv/demo` (and `/en/demo`). The page validates
the `/api/v1/accountability` endpoint by making it tangible for a non-technical user:
a topic input, a party selector, and a four-layer result display (promises, legislation,
votes, budget) with an AI summary. Query state lives in the URL for shareability.
The internal API key is attached server-side via a Server Action and is never included
in the browser bundle or network requests. Three PostHog events track demo usage.
`tsc --noEmit` exits clean.

As a prerequisite, this RFC also bootstraps the complete `next-intl` i18n infrastructure
(`routing`, `navigation`, `request.ts`, message files) and migrates the file-system
proxy convention from the deprecated `middleware.ts` to `proxy.ts` (Next.js 16).

---

## Motivation

The accountability endpoint (RFC-07) needed a concrete demonstration that it was worth
building. The demo page is the answer to that question. It surfaces all four data layers
in a single UI, shows the AI synthesis, and allows results to be shared via URL — making
the cross-source value of the API immediately legible to a non-technical audience. It
also provides a self-service key-request flow so a visitor can move from demo consumer
to API consumer without leaving the page.

---

## Decisions

### `/docs` excluded from the locale proxy matcher

`/docs` is served by a Route Handler (`app/docs/route.ts`) that returns a standalone
`text/html` response with its own `<html>`/`<body>` shell. Because the proxy matcher
originally only excluded `/api/*`, `_next`, `_vercel`, and paths with file extensions,
navigating to `/docs` caused the next-intl middleware to redirect to `/sv/docs`. That
path has no page component, so Next.js fell back to the `[locale]` layout, which
requires `<html>` and `<body>` to come from the page — producing the error
_"Missing \<html\> and \<body\> tags in the root layout"_.

Fixed by adding `docs` to the negative lookahead in the matcher:
`/((?!api|docs|_next|_vercel|.*\\..*).*)`

`/docs` is intentionally not internationalised — the Swagger UI content is language-neutral
and the route is linked to from both locales.

### `middleware.ts` → `proxy.ts`

Next.js 16 deprecated the `middleware` file convention and renamed the exported function
from `middleware()` to `proxy()`. The file is now `apps/web/proxy.ts` and exports
`export function proxy()`. The `config.matcher` pattern is unchanged. Using the old
filename produces a deprecation warning at startup.

### Result rendering consolidated in `QueryWidget`, not split across page and widget

The product request spec splits result rendering in two: the Server Component (`page.tsx`)
renders `initialResult` (from URL params), while `QueryWidget` renders the client-side
`result` state after a new search. In practice this causes both blocks to be visible
simultaneously after a client-side query — `router.push()` updates the URL, which
triggers a Server Component re-render that produces the server block, while the widget's
local `result` state simultaneously renders the client block.

The fix: `QueryWidget` accepts `initialResult` as a prop and is the sole owner of result
rendering. It renders `result` (client) when a search has been done, and falls back to
`initialResult` (server) otherwise. The server component no longer has its own results block.

### `demo_viewed` fired via `after()`, not inline

The `demo_viewed` PostHog server event is fired using Next.js `after()` so it does not
add to the page's response latency. The `posthog-node` client is dynamically imported
inside the `after()` callback, avoiding any server bundle bloat on pages that are not
the demo. `client.shutdown()` is awaited inside the callback to flush the event before
the process continues.

### `PostHogProvider` uses `person_profiles: 'never'`

PostHog is initialised with `person_profiles: 'never'` to prevent any user profiling or
identity linkage. All three demo events (`demo_viewed`, `accountability_query`,
`demo_result_shared`) carry only aggregate-safe properties (locale, party code,
topic length, source count). No query text, IP, or user-identifying data is captured —
consistent with the privacy constraints in `foundation.md §13`.

### `Button asChild` replaced with plain `<a>` elements

Several components in the spec use `<Button asChild>` to render an anchor element with
button styling. The Button component is built on `@base-ui/react/button`, which does not
support the `asChild` prop (a Radix UI convention). These were replaced with `<a>`
elements styled with the equivalent Tailwind classes inline.

### `Select onValueChange` typed as `(val: string | null) => void`

The Select component is built on `@base-ui/react/select`, whose `onValueChange`
callback signature passes `string | null` (nullable deselection). The spec's
`onValueChange={setParty}` did not compile because `setParty` only accepts `string`.
Fixed with `onValueChange={(val) => val !== null && setParty(val)}`.

### Root layout changed to a passthrough

`app/layout.tsx` previously rendered `<html lang="sv"><body>{children}</body></html>`.
With `[locale]` routing, `app/[locale]/layout.tsx` is the correct owner of `<html>`
and `<body>` — it receives the locale from the route segment and sets `lang={locale}`.
The root layout was reduced to `<>{children}</>` (required by Next.js as a non-nullable
React node) and the `html`/`body` shell moved to the locale layout.

### `app/page.tsx` redirects to `/sv`

The root `/` route is handled by the `proxy.ts` locale matcher, which redirects to
`/sv/`. The `app/page.tsx` file adds an explicit `redirect('/sv')` as a belt-and-braces
fallback for any edge case where the proxy config is bypassed (e.g. direct adapter
invocation in tests). This ensures the root is never a blank page.

---

## Files Created

| File | Description |
|---|---|
| `apps/web/proxy.ts` | Locale routing proxy (Next.js 16 convention); wraps `next-intl` middleware |
| `apps/web/i18n/routing.ts` | `defineRouting` config — locales `['sv', 'en']`, default `'sv'` |
| `apps/web/i18n/navigation.ts` | `createNavigation` helpers exported for use in client components |
| `apps/web/i18n/request.ts` | `getRequestConfig` — resolves locale and loads message file per request |
| `apps/web/messages/sv.json` | Swedish translations — `demo` namespace (tagline, apiLink, apiDocs) |
| `apps/web/messages/en.json` | English translations — `demo` namespace |
| `apps/web/app/[locale]/layout.tsx` | Locale-aware layout — `<html lang={locale}>`, `NextIntlClientProvider`, `PostHogProvider` |
| `apps/web/app/[locale]/demo/page.tsx` | Löfteskollen demo — Server Component; server-side pre-fetch; `generateMetadata`; `after()` PostHog event |
| `apps/web/lib/actions/accountability.ts` | `fetchAccountability(party, topic)` Server Action — attaches `AGORA_INTERNAL_API_KEY` server-side; 60s revalidation |
| `apps/web/lib/actions/request-key.ts` | `requestApiKey(email, description)` Server Action — proxies `POST /api/v1/keys/request` |
| `apps/web/components/posthog-provider.tsx` | Browser PostHog provider — no-op when `NEXT_PUBLIC_POSTHOG_KEY` absent; `person_profiles: 'never'` |
| `apps/web/components/features/party-badge.tsx` | Coloured party pill using `PARTY_COLORS` / `PARTY_NAMES` from `lib/utils.ts`; supports `size="sm"` |
| `apps/web/components/features/demo/query-widget.tsx` | Client component — form, URL update, server action call, result rendering, PostHog `accountability_query` event |
| `apps/web/components/features/demo/summary-card.tsx` | AI summary card with `PartyBadge` and graceful null fallback |
| `apps/web/components/features/demo/accountability-layers.tsx` | 2×2 card grid for the four data layers |
| `apps/web/components/features/demo/sources-footer.tsx` | Share button, collapsible source list, PostHog `demo_result_shared` event |
| `apps/web/components/features/demo/request-key-panel.tsx` | Collapsible key-request form — calls `requestApiKey`, displays key once with copy button |

## Files Modified

| File | Change |
|---|---|
| `apps/web/next.config.ts` | Added `withNextIntl` plugin wrapper |
| `apps/web/app/layout.tsx` | Reduced to passthrough `<>{children}</>` — html/body moved to locale layout |
| `apps/web/app/page.tsx` | Replaced placeholder with `redirect('/sv')` fallback |
