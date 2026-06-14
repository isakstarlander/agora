# 11 — Roadmap

This document turns the plans above into a sequence of buildable chunks. It is written to be readable by someone who has never touched AWS — every phase ends with an observable outcome and a rough time budget for a single part-time builder.

Unlike a greenfield roadmap, **we start from the existing implementation in `./agora/`** (the Supabase-based codebase). The work is a port, not a rewrite, in line with `00-foundation.md` guiding principle 10 and `01-critical-review.md`. The schedule below reflects that: ingestion logic, accountability synthesis prompt, frontend components, and UI copy all already exist and transfer with minor changes.

The phases are ordered so that **Phase 3 alone produces a working, useful, public dashboard.** Every phase after that is optional polish.

## Phase 0 — Account hygiene (½ day)

Outcome: an AWS account that can be deployed into without dramatic surprises.

- Create or dedicate an AWS account to Agora; enable MFA on root.
- Create an IAM Identity Center user, assign it `AdministratorAccess` for bootstrap only.
- Enable AWS Budgets with 20 / 30 / 50 USD actual alarms, email-delivered.
- Enable CloudTrail in the home region (free for management events).
- Request **Bedrock model access** for Claude Haiku and Titan Embed v2 in `eu-north-1`.
- Obtain a **Manifesto Project API key** at `manifesto-project.wzb.eu` (free, ~1 business-day turnaround).

Stop here and wait for Bedrock approval before Phase 5.

## Phase 1 — Data spine (3 days)

Outcome: Riksdagen, Statskontoret, and Manifesto data flowing into S3, queryable by DuckDB.

1. Create the CDK skeleton as per `10-iac-bootstrap.md` §§1–3.
2. Port the existing implementation's ingestion scripts into Lambdas:
   - `scripts/ingest/documents.ts` → `fetch-riks-documents` Lambda.
   - `scripts/ingest/voting.ts` → `fetch-riks-votes` Lambda.
   - `scripts/ingest/members.ts` → `fetch-riks-members` Lambda.
   - `scripts/ingest/document-authors.ts` + `document-texts.ts` → `fanout-doctext` Step Functions state machine (see `05-ingestion.md` §6).
   - `scripts/ingest/esv.ts` → `fetch-esv` Lambda (drop the Supabase upserts; write Parquet).
   - `scripts/ingest/manifesto.ts` → `fetch-manifesto` Lambda.
3. Write the Python `transform` Lambda that maps raw JSON/CSV → Parquet partitions as per `04-data-model.md`.
4. Write the Python `derive` Lambda with SQL files for the derived tables.
5. Deploy `AgoraDataStack`. Let it run for 48 hours.
6. From a laptop, run a couple of DuckDB queries against the Parquet directly to sanity-check the schema. Example:

   ```sql
   SELECT parti, COUNT(*)
     FROM read_parquet('s3://agora-parquet-<acct>/vote_results/year=*/part-*.parquet')
    WHERE rost = 'Ja' AND year(datum) = 2025
    GROUP BY ALL ORDER BY 2 DESC;
   ```

Acceptance: at least 10k vote results, at least 1k documents, at least 349 members, at least 500 `budget_outcomes` rows, at least 200 `manifesto_statements` rows.

## Phase 2 — Read API (½ week)

Outcome: a JSON HTTP API that returns real data.

1. Implement `AgoraApiStack` minus the llm-read Lambda and the accountability routes.
2. Implement routes: `/v1/health`, `/v1/members`, `/v1/documents`, `/v1/votes`, `/v1/members/{iid}/attendance`, `/v1/party-cohesion`, `/v1/party-divergence`, `/v1/budget`, `/v1/manifestos`.
3. Smoke-test with `curl` from a laptop.
4. Add CloudFront caching (in `AgoraWebStack`) in front of the API Gateway — even before a frontend exists.

Acceptance: `curl https://<cloudfront-url>/v1/party-cohesion?rm=2024/25` returns JSON in under 1 s (warm).

## Phase 3 — Port the Next.js dashboard (1 week)

Outcome: a public URL, in Swedish, that a friend can open on their phone.

The existing implementation's `apps/web` is Next.js + `next-intl` + shadcn + Tailwind 4. We **keep the code** and migrate the hosting.

1. In `web/`, add `output: 'export'` to `next.config.ts`; set `images.unoptimized = true`.
2. Replace every `@supabase/supabase-js` call with a `fetch('/v1/...')` call against the new API Gateway. The existing implementation already abstracts data fetching through a small set of functions — this is a one-file change in most cases.
3. Remove `posthog-js` and `@sentry/nextjs` wiring; remove the corresponding env vars from the build.
4. Remove the `/api-keys` and `/admin` routes and components.
5. `npm run build` produces `./out/`. `cdk deploy AgoraWebStack` syncs it to `s3://agora-web/` and invalidates CloudFront.
6. Add the `/metodik/*` pages (sammanfattning + ansvarsutkrävande + sokning first; per-metric pages can lag).
7. Configure the WAF rate rule (or the CF-Function alternative).
8. Ask three non-technical Swedes to use it for 15 minutes and take notes.

Acceptance: the end-goal user story in `00-foundation.md` (*"open one page on my phone, pick a period, understand what the Riksdag has done"*) can be acted out on the deployed site.

## Phase 4 — Observability & cost control (2 days)

Outcome: you get an email if something breaks or costs money.

1. Implement `AgoraObsStack` (dashboard, SNS, alarms, Budgets, weekly digest Lambda).
2. Verify the SES domain / email identity, confirm SNS subscription.
3. Wait for the first Monday digest to land in your inbox.
4. Tune alarm thresholds based on observed traffic.

Acceptance: a synthetic test (e.g. paste a bad SQL into the `api` Lambda) triggers a CloudWatch alarm that reaches your inbox within 5 minutes.

## Phase 5 — Summaries and hybrid search (3 days)

Outcome: one-tap summaries on motion pages, natural-language search in the site.

1. Deploy `AgoraApiStack` with `llm-read`: `/v1/summarise` and `/v1/search`.
2. Deploy the weekly `embed-chunks` Lambda and wait for a full pass of the document corpus.
3. Port the existing implementation's `<SummaryBlock>` component (or equivalent) and wire it to the new endpoint.
4. Port `/sok` and wire it to the new hybrid-search endpoint.
5. Publish the summarisation prompt at `/metodik/sammanfattning` and the hybrid-search method at `/metodik/sokning`.

Acceptance: a summary returns in under 3 s end-to-end on a warm endpoint; `/sok` for "barnomsorg" returns plausibly-related motions.

## Phase 6 — Accountability synthesis (3 days)

Outcome: the feature that directly answers the foundation-document end-goal sentence.

1. Deploy `AgoraLlmStack` (SQS + `llm-acc` worker + DynamoDB caches).
2. Wire `POST /v1/accountability` (enqueue) and `GET /v1/accountability/jobs/{id}` (poll) through API Gateway.
3. Port the existing implementation's `/api/v1/accountability` handler's prompt and four-layer retrieval; the SQL shapes move from PostgREST/SQL-over-Supabase to DuckDB-over-Parquet.
4. Build the `/ansvar` UI page with the (party, topic, period) picker and a polling progress widget.
5. Publish the prompt at `/metodik/ansvarsutkravande`.

Acceptance: a cold request for `(S, förskola, 2022–2026)` returns a cited ~150-word report within 15 s end-to-end; a second request for the same inputs returns in under 200 ms.

## Phase 7 — Polish (ongoing)

Things worth doing once the above ships:

- Party-cohesion time-series chart on party pages.
- CSV / Parquet download buttons on each table page (zero extra cost: we already have the files).
- Requester-pays mirror of `s3://agora-parquet/` for bulk-data consumers — the free channel for anyone who wants a full dump rather than a live API.
- A Swedish-language accessibility audit with a real screen-reader user.
- A small `/nyheter` page that lists the most recent 20 ingested documents, with RSS.
- Löfteskollen-style landing page: the accountability endpoint with a curated list of (party, topic) chips for quick exploration. The implementation's internal demo becomes a public widget.

## Phase 8 — Post-MVP expansions (parked)

Reintroduce only if they earn their keep against the end-goal:

- **Budget monthly granularity.** Supplement the annual årsutfall with ESV's monthly preliminary figures.
- **Speech full-text and speaking-time drilldowns.** Currently metadata-only.
- **Co-authorship graphs.** Data is in `document_authors`; the UI is the work.
- **Committee-meeting attendance.** Requires new ingestion against `utskottsmoten` endpoints.
- **2026 manifesto corpus.** Post-election, once WZB codes the manifestos.

## Phase 9 — Commercial API tier (optional, post-launch)

Outcome: a second product alongside the dashboard — a paid developer tier on the same `/v1` endpoints, aimed at Swedish newsrooms, polling firms, political consultancies, and academic research teams that need higher rate limits, guaranteed throughput, and an email-backed SLA.

**Pre-conditions before starting Phase 9.** All three must hold:

1. The free-tier dashboard has been live for at least 3 months with no open data-correctness complaints.
2. At least three external parties have asked, unprompted, whether they can rely on the API.
3. The maintainer has capacity for a small customer-success workload (responding to emails within 1–2 business days).

If any of the three is unmet, defer Phase 9.

**Build steps (≈ 2 weeks, part-time):**

1. Flip `-c apiTiers=on`; `cdk deploy AgoraApiStack`. This provisions:
   - `api_keys` DynamoDB table (`key_hash → {tier, active, stripe_customer_id, owner_email, rate_limit_rpm, monthly_quota, created_at, last_used_at}`).
   - Lambda authorizer (reads `api_keys`, returns the authorizer context documented in `06-storage-and-api.md` §7.3).
   - `AgoraAuthorizerRole` and `AgoraKeyAdminRole` IAM roles.
   - Empty secrets `/agora/api_keys/pepper` and `/agora/stripe/*`.
2. Populate the Stripe secrets and the API-key pepper per `10-iac-bootstrap.md` §4 "Phase 9 additional one-off steps".
3. Implement `key-admin` Lambda with four endpoints, all behind the same authorizer but with a special `admin` scope:
   - `POST /v1/stripe/webhook` — handle `customer.subscription.created/updated/deleted`; upsert `api_keys` row.
   - `POST /v1/me/keys` — issue a new key, return it once, store only the hash.
   - `GET /v1/me/keys` — list keys (metadata only, never the raw value).
   - `DELETE /v1/me/keys/{key_hash}` — revoke a key.
4. Build the `/dev` dashboard page — a one-screen UI for signing in with Stripe Checkout, issuing and rotating keys, and viewing monthly usage. Swedish + English strings.
5. Publish `/v1/openapi.json` as the canonical reference (already generated — see `06-storage-and-api.md` §7.2).
6. Write the `/priser` page: free tier vs. three paid tiers, clearly pricing the SLA and throughput, **not** the data (the data is public; see `00-foundation.md` §3).
7. Enable the `ApiRequests` and `ApiPrincipalThrottles` CloudWatch alarms on `tier=press` / `tier=enterprise` dimensions.
8. Add a "monthly usage report" Lambda + EventBridge schedule that emails each paying customer their own usage in CSV form, derived from `ApiRequests` logs.

**Suggested initial tiering (illustrative — pricing is a business decision, not an architectural one):**

| Tier | Rate limit | Monthly quota | Price | Target |
|---|---|---|---|---|
| `free` | 20 req/min/IP | — | — | Citizens, occasional scripts |
| `hobby` | 120 req/min | 500 k / mo | ~€19 / mo | Solo journalists, students |
| `press` | 600 req/min | 5 M / mo | ~€99 / mo | Newsrooms, polling firms |
| `enterprise` | negotiated | negotiated | negotiated | Public-sector consultancies |

Exact values fine-tuned from the first six months of free-tier telemetry.

**Acceptance:**

- A test account subscribed via Stripe Checkout can hit `/v1/documents` at 120 req/min without a 429, and is throttled at 121 req/min.
- Revoking the key via `DELETE /v1/me/keys/{hash}` causes the next call with that key to return 401 within 60 s (authorizer cache TTL).
- A monthly usage CSV arrives in the customer's inbox on the first Monday of the month.
- The free tier continues to return the same responses with `X-Tier: free` and its existing rate limit — no regression, no mandatory paywall on any endpoint.

**Explicit non-goals of Phase 9:**

- No separate data-access tier. Paying customers get *more* requests and *faster* support on the same endpoints; they do not get different data. (Offentlighetsprincipen + `00-foundation.md` §3.)
- No private endpoints. Every route that exists in `/v1` is documented in the public OpenAPI spec, regardless of the authorizer's decision.
- No dashboard changes. The dashboard keeps calling the free-tier API; paid-tier consumers are server-to-server.

## Cut-list

If time runs out during Phase 3, cut in this order — doing so still leaves a product that meets the end-goal:

1. `/metodik/*` sub-pages beyond the three first-class ones (sammanfattning, ansvarsutkrävande, sokning). The SQL can live in the git repo instead.
2. Dark mode.
3. `/partier` divergence matrix (the per-member cohesion view conveys similar information).
4. `/voteringar` bulk browser (leave the per-motion vote drill-down and remove the bulk list).
5. English locale (keep the routing primitive; leave bundles Swedish-only for MVP).

Do **not** cut:

- Period-scope picker (the end-goal literally names it).
- Source links on every rendered fact (the product promise).
- The Swedish-language copy (the audience is Swedish citizens).
- The `/ansvar` accountability page (it is the end-goal; see `01-critical-review.md` §5).
- Citations on every LLM-generated block (product safety).

## Project health check at each phase end

A short checklist the maintainer runs at every phase boundary:

1. Did the most recent AWS bill land within plan? (Target: <$10/mo steady state, <$15/mo spike; alarms at 20/30/50.)
2. Are any CloudWatch alarms firing?
3. Has Riksdagen, Statskontoret, or the Manifesto Project published anything about their feeds in the last 30 days that would affect us?
4. Are there any open privacy / accuracy complaints in the `/om`-page contact inbox or the `Rapportera` mailto?
5. Does the end-goal user story still hold on the deployed site?
6. Has anyone tried to re-introduce Supabase, a custom `api_keys` table / Upstash rate counter, or hosted Postgres? (See `01-critical-review.md` §7. Enabling the native API Gateway usage-plan path for Phase 9 does **not** count as a violation — that is the explicitly preserved commercial path in `01-critical-review.md` §6.1.)

If any answer is "no" or "not sure", address it before advancing.
