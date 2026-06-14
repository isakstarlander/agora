# PR-16 — Production cutover

## Outcome

Agora is **live at the chosen domain** (custom domain if configured in PR-10, else the CloudFront `*.cloudfront.net` URL) with all five stacks deployed, all PR-00–PR-14 manual steps executed and verified, a signed-off cutover checklist in `docs/cutover.md`, and a post-launch monitoring window documented. The project's success criterion — *"a Swedish citizen opens one page on their phone and understands what the Riksdag has done"* — is acted out end-to-end on the deployed site by a non-technical user.

## Roadmap anchor

`11-roadmap.md` — end of Phase 6 / start of Phase 7; `00-foundation.md` end-goal; `09-observability-and-security.md` §4 (launch checklist).

## Prerequisites

- **Every** PR from PR-00 to PR-15 merged and deployed. The cutover PR is deliberately last in the sequence.
- A DNS zone at the target domain exists (if a custom domain is desired). Route 53 recommended; any registrar works if the NS delegation is pointed.
- The maintainer has read `00-foundation.md`, `01-critical-review.md`, and `09-observability-and-security.md` §§1–3 within the last week.

## Context

The project has been shipped one stack at a time. This PR is the moment where the maintainer stops calling it "the port" and starts calling it "the site". Its deliverable is a single signed-off checklist, not new code. Its purpose is to force the maintainer to **actually** exercise the three attributes the foundation document insists on:

1. A citizen without prior AWS / political-data knowledge can read the site and learn.
2. Every rendered fact carries a source, and the source is reachable in one tap.
3. The whole system stays under the coffee-budget cost cap.

Anything the cutover reveals as broken becomes a corrective PR. The work here is disciplined walking-through, not building.

## Scope / Deliverables

### 1. Pre-launch gate

Tick every box before touching DNS:

**AWS account hygiene**
- [ ] Root account MFA enabled.
- [ ] No IAM users outside Identity Center.
- [ ] CloudTrail enabled, logs reaching `agora-logs` (or the account's default trail bucket).
- [ ] AWS Budgets 20 / 30 / 50 USD in place; SNS subscription confirmed; test email received.
- [ ] Bedrock model access confirmed `AVAILABLE` for Claude 3 Haiku and Titan Embed v2 in `eu-north-1`.

**Ingestion pipeline**
- [ ] `ingestion_runs` has rows from all six Riksdagen Lambdas, ESV, and Manifesto Project within the last 7 days.
- [ ] `agora-raw/` contains doc-text gzip files for ≥ 1,000 `dok_id`s.
- [ ] Every `agora-parquet/<table>/` prefix contains `_SUCCESS.json` within 24 h of the latest `ingestion_runs` entry.
- [ ] DuckDB query `SELECT COUNT(*) FROM votes` returns ≥ 10,000.
- [ ] DuckDB query `SELECT COUNT(*) FROM documents` returns ≥ 1,000.
- [ ] DuckDB query `SELECT COUNT(*) FROM budget_outcomes` returns ≥ 500.
- [ ] DuckDB query `SELECT COUNT(DISTINCT dok_id) FROM document_embeddings` is within 5% of `SELECT COUNT(DISTINCT dok_id) FROM document_chunks` (i.e. the embedding pass has caught up).

**API**
- [ ] `GET /v1/health` returns `200 {"status":"ok"}`.
- [ ] Every route in `06-storage-and-api.md` §2.2 returns `200` on a well-formed request, `4xx` on malformed, and the error shape is RFC 7807.
- [ ] `POST /v1/summarise` on three randomly-picked `dok_id`s returns a well-formed 3-sentence Swedish summary.
- [ ] `POST /v1/search {"q":"barnomsorg"}` returns plausibly-related items; spot-check titles.
- [ ] `POST /v1/accountability {"party":"S", …}` returns `202` → `done` within 15 s; report is cited and ≤180 words.
- [ ] Rate limiting: 25 rapid-fire calls from one IP to `/v1/accountability` triggers a `429` on call #21.

**Dashboard**
- [ ] `/sv/` renders in <2 s on a throttled 3G connection (Chrome DevTools).
- [ ] Every chart on every page pulls real data (no empty states).
- [ ] Every list page has pagination that works (Next → Previous → back to the same row).
- [ ] The `/sv/ansvar/` page submits, polls, and renders an accountability report for `(S, förskola, 2022–2026)`.
- [ ] `/sv/sok/?q=förskoleplatser` returns 10+ results in <1 s.
- [ ] Every AI-generated block has: AI chip, timestamp, model id, prompt-link to `/metodik/*`, and `Rapportera` mailto.
- [ ] Footer shows the three data attributions and the "not affiliated" disclaimer (`03-data-sources.md` §1.2).
- [ ] `/sv/om/` page exists with contact email and accountability-correction instructions.

**Security**
- [ ] CloudFront response headers include `Strict-Transport-Security`, `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
- [ ] S3 buckets all have `Block Public Access = On`.
- [ ] `aws s3api get-bucket-policy --bucket agora-web-<acct>` returns a policy that grants CloudFront OAC only — no `"Principal": "*"`.
- [ ] WAF (or the CF-function alternative) rate-limits at 300/5 min/IP.
- [ ] DynamoDB tables are encrypted at rest (AWS-managed KMS key is fine).
- [ ] SSM params `/agora/llm/enabled` and `/agora/llm/monthly_token_cap` exist and are set to sane values.

**Observability**
- [ ] CloudWatch dashboard `AgoraOps` renders all 6 widgets with data.
- [ ] All 15 alarms from PR-11's table exist and are in `OK` state.
- [ ] Synthetic alarm test (`aws cloudwatch set-alarm-state --alarm-name agora-ApiErrors5xxHigh …`) produces an email within 60 s.
- [ ] Weekly digest Lambda invocation produces a Markdown email summarising the last 7 days.

**Legal / content**
- [ ] Privacy note on `/sv/om/` explicitly states: no cookies, no analytics, no user tracking, no account creation, no PII collected.
- [ ] The `Rapportera` mailto address has a human mailbox behind it that the maintainer checks.
- [ ] Methodology pages `/metodik/sammanfattning`, `/metodik/ansvarsutkravande`, `/metodik/sokning` render the live prompts / pipelines.
- [ ] `/sv/om/` credits the three data sources with live links, plus the "not affiliated" text in Swedish.

### 2. Cutover sequence

Execute in exactly this order. Each step has a verification; do not proceed if any verification fails.

1. **Freeze code.** Create a release tag `v1.0.0-cutover` on `main`. All subsequent hotfixes cherry-pick from this tag.
2. **Re-deploy everything from `main`.** Manually run `deploy.yml` via `workflow_dispatch`. Verify `smoke` job passes.
3. **Warm the caches.** Hit the 30 most-trafficked expected routes from `curl` × 3 (to prime both API and CloudFront).
4. **Switch DNS** (if using a custom domain). In Route 53, update the `A/AAAA` alias for `<domain>` to the CloudFront distribution. TTL ≤ 60 s for the switch; increase after 24 h.
5. **Verify HTTPS end-to-end.** `curl -v https://<domain>/v1/health` must show `HTTP/2 200` and the ACM certificate for `<domain>`.
6. **Invalidate CloudFront** once: `aws cloudfront create-invalidation --distribution-id <id> --paths "/*"`. Only needed here (subsequent deploys invalidate automatically per PR-10).
7. **Announce.** Send a plain-text email to three named friends with the URL and a request to break it. Wait 24 h for responses.

### 3. Post-launch monitoring window (48 h)

For 48 hours after DNS flip, the maintainer does the following daily:

- Check the CloudWatch dashboard.
- Check the `AgoraOps` SNS email for any alarm notifications.
- Check the `Rapportera` mailbox for user reports.
- Spot-check three arbitrary LLM outputs for accuracy and neutrality.
- Note any cost anomaly against the Budgets.

If any alarm fires or any report shows a data-correctness problem, open a **follow-up PR** (not hotfix-in-place). The discipline of documented corrections preserves the audit trail that is a core part of the trust product.

### 4. `docs/cutover.md`

Create this file on `main` in the same PR; it is the signed-off record of the cutover. Shape:

```markdown
# Cutover — Agora v1.0.0 (<date>)

## Pre-launch gate
(tick-boxes from §1, each with a one-line evidence pointer: console screenshot name, CloudWatch query, etc.)

## Cutover sequence
(timestamps of each step in §2)

## 48-h monitoring log
(short daily entry per day)

## Sign-off
Maintainer: <name>
Date: <date>
Release tag: v1.0.0-cutover
```

This file is the permanent evidence that the invariants were checked by a human. It is never edited after sign-off; corrections live in later PRs.

### 5. User-story walkthrough

A non-technical user (not the maintainer) is observed performing the foundation-document user story on the live site:

> "Open one page on my phone, pick a period, understand what the Riksdag has done about X."

The walkthrough is recorded as notes in `docs/cutover.md` under **Sign-off**:

- Did they find the `/ansvar/` page?
- Could they operate the `(party, topic, period)` picker without prompting?
- Did they understand the output without needing an explanation of "manifesto" or "motion"?
- Did they click a source to verify a claim?

Any answer that is *"no"* is a PR-17-or-later improvement task; it does not block cutover. It does, however, get written down so it is not forgotten.

### 6. Release notes

A public `CHANGELOG.md` at the repo root with one entry:

```markdown
## v1.0.0 — <date>

First public release of Agora.

- Full ingestion of riksdagen.se (documents, votes, members, speeches) back to 2018.
- ESV årsutfall budget outturns 2000–2024.
- Manifesto Project statements for SE parties 1997–present.
- Hybrid FTS + embedding search across all motion/proposition/committee bodies.
- Neutral 3-sentence Swedish document summaries (Claude 3 Haiku via Amazon Bedrock).
- Four-layer accountability synthesis for (party, topic, period) triples.
- Dashboard in Swedish with English fallback; static-export on CloudFront + S3.
- All infrastructure defined as code (AWS CDK, 5 stacks).
```

## Manual steps

1. **Schedule the cutover window.** Pick a 3-hour window on a weekday morning Stockholm time, when Bedrock and CloudFront latencies have been stable. Announce to nobody; this is a quiet cutover.
2. **Have two terminals open** to the AWS account (one for `aws cloudwatch …`, one for `curl …`) and a browser on the future domain.
3. **If something breaks during cutover**, prefer *reverting the DNS* over editing anything in AWS. CloudFront / API Gateway are stable; DNS rollback in Route 53 is one edit.
4. **After cutover**, leave the working account's IAM Identity Center user at `AdministratorAccess` for the 48-hour window only; then downscope to a narrower role as per `09-observability-and-security.md` §2.
5. **Delete the console-created AWS Budgets from PR-00** now that the CDK-managed ones from PR-11 have demonstrated at least one threshold notification. Verify no gap in coverage.

## Acceptance criteria

- [ ] `docs/cutover.md` exists on `main` with every §1 box ticked, §2 step timestamped, and the 48-h log filled in.
- [ ] A non-technical user performed the foundation-document user story on the live site; their notes are captured in the cutover doc.
- [ ] `CHANGELOG.md` exists with a `v1.0.0` entry.
- [ ] The GitHub release `v1.0.0-cutover` is tagged and has release notes matching the CHANGELOG entry.
- [ ] No AWS Budget threshold has fired within the 48-h window.
- [ ] `agora-ops-alerts` has received zero non-synthetic alarms within the 48-h window. (If it has, a follow-up PR is filed; cutover does not retroactively un-happen.)
- [ ] The maintainer has written a one-sentence statement, in plain Swedish, of what the product does, that a non-technical Swede would understand. Captured in `docs/cutover.md` §Sign-off.

## Out of scope

- Phase 7 polish (party-cohesion time series, CSV download buttons, requester-pays mirror). Those are separate post-launch PRs.
- Phase 8 expansions (monthly budget granularity, speech full-text, co-authorship graphs, committee attendance). Parked per `11-roadmap.md`.
- Phase 9 commercial tier. Own PR (PR-17).
- Marketing and SEO. Not part of this project's purpose.
- Analytics. Explicitly excluded: no PostHog, no GA, no server-side analytics. The `Rapportera` mailbox and AWS WAF request counts are the entirety of the product's feedback loop.
- A post-mortem template. There is nothing to post-mortem; this PR *is* the launch record.
