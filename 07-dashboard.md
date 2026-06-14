# 07 — Dashboard

This document describes the citizen-facing frontend. It is deliberately the shortest engineering document in this folder, because the frontend is deliberately the simplest part of the system.

## 1. Technical choice

**Next.js (App Router) with `output: 'export'`**, served as a pre-rendered static site from S3 via CloudFront.

The existing implementation in `./agora/` is a Next.js app with `next-intl`, shadcn/ui, Tailwind 4, and Recharts. We **keep that code** — rewriting the frontend to SvelteKit would discard weeks of working UI to save bytes that do not matter on a Swedish 5G mobile network. The migration from the existing implementation to this plan is a **port, not a rewrite**, per `01-critical-review.md` guiding principle 10.

What changes vs. the existing implementation:

- Drop Vercel hosting; serve from S3 + CloudFront. The `next.config.ts` gets `output: 'export'` and `images: { unoptimized: true }`.
- Drop PostHog (`posthog-js`) and Sentry (`@sentry/nextjs`). CloudWatch logs and WAF metrics replace them.
- Drop `/admin` and `/dev` routes if they exist (the implementation's API-key self-service UI is cut with the API-key product).
- Keep `next-intl` — Swedish-primary, English as a best-effort secondary, per `00-foundation.md` §3.1.

Why static rather than server-rendered:

- Content is either (a) cacheable API responses we fetch at runtime, or (b) data that changes on a daily cadence. There is no per-user content.
- CloudFront + S3 serves static sites for ~$0.10 / 1 GB. SSR on Lambda@Edge is multiple orders of magnitude more expensive per request.

Client-side data fetching hits the HTTP API (CloudFront cached) directly. Where a page is fully determined by build-time data (e.g. the methodology pages), it is prerendered to HTML. Where it is determined by a URL parameter (e.g. `/ledamoter/[iid]`), we use a combination of generated-at-build-time index pages and client-side fetch for detail.

## 2. Styling

**Tailwind CSS 4** + **shadcn/ui** (Radix under the hood) — both inherited from the existing implementation. No new design system at MVP.

The colour palette uses **official party colours** for the party-badge component (e.g. S red, M blue) so that citizens recognise the affiliations at a glance. We intentionally do *not* use a colour gradient that suggests left–right ordering; that framing is editorial.

Charts use **Recharts** (already wired in the implementation) for the attendance, cohesion, and divergence views.

## 3. Page inventory (MVP)

| Route | Name | Summary |
|---|---|---|
| `/` | *Startsidan* | Period-scoped overview: latest votes, most active MPs, top-ten motions, budget headline. |
| `/ledamoter` | *Ledamöter* | Filterable/sortable list of MPs. |
| `/ledamoter/[iid]` | *Ledamot* | Member detail: bio, attendance, recent votes, party cohesion trend, speaking time. |
| `/motioner` | *Motioner* | Filterable list of motions (doctype `mot`). |
| `/motioner/[dok_id]` | *Motion* | Motion detail: title, proposer(s), committee, 3-sentence summary, links to the full document. |
| `/propositioner` | *Propositioner* | List of government bills (doctype `prop`). |
| `/interpellationer` | *Interpellationer* | List of oral questions (doctype `ip`). |
| `/voteringar` | *Voteringar* | Browse vote points with party-breakdown bars. |
| `/voteringar/[votering_id]` | *Votering* | Per-MP vote list with "voted against own party" highlights. |
| `/partier` | *Partier* | Party overview and party-to-party divergence matrix for the selected period. |
| `/partier/[parti]` | *Parti* | Per-party page: manifesto commitments, motions submitted, voting cohesion. |
| `/budget` | *Budget* | Expenditure-area outturns over the selected period. |
| `/budget/[uo]` | *Utgiftsområde* | Per-area detail with per-anslag drilldown. |
| `/ansvar` | *Ansvarsutkrävande* | The accountability endpoint's UI: pick party + topic + period → cited report. |
| `/sok` | *Sök* | Hybrid natural-language + keyword search. |
| `/om` | *Om Agora* | Methodology, source attribution, contact, project status. |
| `/metodik/sammanfattning` | *Metodik – sammanfattning* | The summarisation prompt verbatim, plus a worked example. |
| `/metodik/ansvarsutkravande` | *Metodik – ansvarsutkrävande* | The accountability prompt verbatim, plus the four-layer retrieval description. |
| `/metodik/sokning` | *Metodik – sökning* | Hybrid-search weighting and the SQL for the FTS leg. |
| `/metodik/[metric]` | *Metodik – metrics* | Per-metric methodology pages, each linking to the exact SQL that computes the metric. |

Every page has a persistent source-link control in the top-right that links to the primary source for the view ("Öppna källan hos riksdagen.se").

## 4. Period-scoping

The "defined period" concept from the end-goal is a **global control** sitting in the app shell. It is a small date-range picker plus shortcut chips (*Innevarande riksmöte*, *Senaste året*, *Senaste mandatperioden*, *Anpassad*).

Period is encoded in the URL as `?from=YYYY-MM-DD&to=YYYY-MM-DD` so that any view is shareable and bookmarkable. When a citizen copies and pastes a link on social media, the period travels with it.

## 5. Interactivity

Only the following interactions change application state:

1. **Period picker** — changes the URL query string; pages re-fetch.
2. **Filter dropdowns** — same.
3. **Sort by column** — client-side sort on already-fetched data.
4. **Search input** (on `/sok`) — debounced 300 ms, calls `/v1/search`.
5. **Accountability form** (on `/ansvar`) — calls `POST /v1/accountability`; on `202`, polls `/v1/accountability/jobs/{id}` every 1.5 s until `state=done`.
6. **Expandable row details** — pure client-side.

There is no drag-and-drop, no tab persistence, no wizard flow. Minimalism is the feature.

## 6. Accessibility

- All colour-coded elements have a text fallback (the party-badge shows the party letter).
- Colour palette passes WCAG AA contrast on light and dark backgrounds.
- Dark mode via `prefers-color-scheme`.
- Every interactive control is reachable by keyboard; focus outlines are not suppressed.
- Images (`bild_url_80`) have `alt` text containing the member's name.
- No auto-playing media, no modal that traps focus without an explicit close button.
- Accountability reports and summaries are rendered with `role="region"` and an accessible name that makes their AI-generated status obvious to screen readers.

## 7. Internationalisation

**Primary: Swedish.** UI strings, error messages, and page titles are in Swedish. Dates formatted as `20 apr 2026`. Numbers use space as thousands separator and comma as decimal per Swedish convention.

**Secondary: English.** Preserved as a routing primitive (`/[locale]/...` via `next-intl`, which the existing implementation has wired). English message bundles are best-effort at MVP; gaps fall back to the Swedish string. See `00-foundation.md` §3.1 for the rationale.

## 8. Build and deploy

```bash
npm run build            # Next.js static export into ./out/
cdk deploy AgoraWebStack # syncs ./out/ to s3://agora-web/, invalidates CloudFront
```

Build artefacts under 200 KB gzip per lazy-loaded page bundle. Page-load TTFB is CloudFront-edge-latency + static-asset size — sub-200 ms from Stockholm in practice.

## 9. Source-of-truth invariants

A few invariants the frontend enforces, because they are part of the product promise:

- **No claim without a source.** Every rendered fact either shows a source link or is derived from facts on the same page that show one.
- **Summaries and accountability reports marked as such.** `summary_sv` values from `/v1/documents/{id}` are rendered inside a component that has a visible "AI-genererad sammanfattning — klicka för att läsa originaldokumentet" chip. Accountability reports carry a matching chip plus the generation timestamp, the model id, and a prompt-version link to the methodology page.
- **Rapportera-a-mistake link.** Every generated block has a small "Rapportera" mailto link that pre-fills the `dok_id` / `job_id` and the exact text of the generated output. This is the human-in-the-loop safeguard against LLM errors.
- **No infinite scroll.** Paginated tables use explicit "Next / Previous" buttons so that shareable URLs work and cost-per-scroll is predictable.
- **No personal state.** No local storage of user preferences. The URL is the state.
