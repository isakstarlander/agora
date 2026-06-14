# 09 — Observability and security

This document defines what we log, what we alarm on, and how we prevent the site from being abused. It is deliberately sober: for a project at this scale, "observability" is mostly a small number of well-chosen metrics and a budget alarm.

## 1. Observability

### 1.1 Logs

Every Lambda writes structured JSON logs to CloudWatch Logs. One line per invocation summary + additional lines for warnings/errors. No per-request debug logs in production (they cost money and leak nothing useful at our scale).

Common fields:

```json
{
  "ts":         "2026-04-20T06:00:13.412Z",
  "service":    "agora-api" | "agora-ingest-fetch" | "agora-transform" | "agora-derive" | "agora-llm",
  "request_id": "<lambda request id>",
  "event":      "<dotted-event-name>",
  "duration_ms":0,
  "principal_id": "anon" | "ip#<ip-24-masked>" | "key#<sha256-prefix>",
  "tier":       "free" | "hobby" | "press" | "enterprise",
  ...
}
```

`principal_id` and `tier` are emitted on every `agora-api` / `agora-llm-read` / `agora-enqueue-accountability` invocation. At MVP every value is `ip#...` + `free`; the field is populated regardless so Phase-9 usage reports are a SELECT rather than a code change. The **raw API key is never logged** — only its 16-char SHA-256 prefix. IPs are `/24`-masked in persistent log storage; the full IP lives in memory only for the duration of a single request (for rate-limit lookups) and is not emitted.

Retention: **30 days** on all log groups. Anything we want longer-lived (weekly digests, counts) is aggregated into a 10-row DynamoDB table at run-time.

### 1.2 Metrics

CloudWatch custom metrics, emitted via Embedded Metric Format (EMF) from the logs so we pay nothing extra for the emission:

| Metric | Unit | Source | Alarm threshold |
|---|---|---|---|
| `IngestNewDocs` | Count | agora-ingest-fetch-* | none; tracked for trending |
| `IngestErrors` | Count | agora-ingest-fetch-* | >3 within 1 hour |
| `TransformErrors` | Count | agora-transform | >0 within 1 hour |
| `ApiLatencyMs` | Milliseconds (p95) | agora-api | p95 > 2000 ms |
| `ApiErrors5xx` | Count | agora-api | >5 within 5 minutes |
| `LlmTokensInput` | Count | agora-llm-read / agora-llm-acc | none; tracked for cost forecast |
| `LlmTokensOutput` | Count | agora-llm-read / agora-llm-acc | none |
| `AccountabilityJobDurationMs` | Milliseconds (p95) | agora-llm-acc | p95 > 15000 ms |
| `AccountabilityJobFailures` | Count | agora-llm-acc | >3 within 1 hour |
| `WafRateLimitHits` | Count | WAF | >100 within 5 minutes signals abuse |
| `ApiRequests` | Count, dimensioned by `(route, tier)` | agora-api | none; used for per-tier usage reports |
| `ApiPrincipalThrottles` | Count, dimensioned by `tier` | agora-api | >50 within 10 min on `tier=free` is background abuse; any value on `tier≠free` is a paying customer hitting their quota and must trigger a customer-success workflow |

### 1.3 Dashboards

A single CloudWatch dashboard named `AgoraOps`. Six widgets: API RPS & p95, ingest health, transform health, LLM usage, WAF hits, monthly cost forecast (via AWS Budgets widget).

### 1.4 Alerting

Alarms publish to one SNS topic (`agora-ops-alerts`) with a single subscription: an email address read from SSM Parameter Store (`/agora/ops/alert_email`). No pagers, no on-call. This is a civic-tech project, not a PagerDuty customer.

### 1.5 Weekly digest

A scheduled Lambda (Monday 07:00 Europe/Stockholm) reads the previous week's metrics and emails the maintainer via SES:

- new documents ingested, by doktyp
- votes processed
- API RPS (avg, p95)
- number of summaries generated, tokens consumed
- estimated cost to date this month
- any alarms triggered

## 2. Cost control

### 2.1 AWS Budgets

Three Budgets at **20, 30, and 50 USD** of monthly actual spend. The 50 USD budget also sends a **forecast** alarm if AWS predicts we will exceed $75. All three notify the same SNS topic.

Rationale for the thresholds: the cost model in `02-architecture.md` §5 projects ~$9/month steady state with the WAF variant, or ~$3.50/month with the CloudFront-Function variant. A 20 USD alarm fires at ~2× projected, giving early warning before anything is broken; 30 USD and 50 USD are progressive escalations if the first alarm is missed.

### 2.2 Per-service cost guards

- **Bedrock:** the LLM Lambdas keep a running monthly token counter in DynamoDB. If it crosses a configurable ceiling (default 10M input tokens / month), `/v1/summarise`, `/v1/search`, and `/v1/accountability` return 503 with a source-URL fallback. The counter resets on the first of the month. A feature flag in SSM Parameter Store (`/agora/llm/enabled`) provides a hard kill switch.
- **CloudFront:** no per-distribution cap, but the WAF rate-rule caps requests per IP, which is the dominant abuse vector.
- **DynamoDB:** on-demand billing only — no provisioned capacity that could be accidentally overprovisioned.
- **S3:** lifecycle rules transition raw data to IA and Glacier as per `06-storage-and-api.md` §1.1.
- **Step Functions:** the `fanout-doctext` state machine uses the Standard workflow; at Agora's transition rates (≲1,000/day) it costs cents.

## 3. Security

### 3.1 Threat model

The threats we take seriously:

- **Abusive automated scraping** of the expensive endpoints (`/v1/summarise`, `/v1/search`). Mitigation: WAF rate-rule + per-principal DynamoDB throttle.
- **Denial of wallet** via bulk LLM calls. Mitigation: per-month Bedrock token ceiling (section 2.2).
- **Compromised ingestion Lambda → AWS account takeover.** Mitigation: each Lambda has a narrow IAM role; the ingestion Lambda can only write to `agora-raw/*` and read/write its own DynamoDB cursor.
- **Tampered Parquet files producing misleading answers.** Mitigation: S3 bucket versioning on `agora-parquet` + a daily checksum Lambda that compares the current `_SUCCESS` manifest against the last known-good snapshot in DynamoDB, alerting on unexpected changes.
- **Prompt injection** in motion text causing misleading summaries. Mitigation: prompt design (section 4 of `08-llm-layer.md`); and the product rule that summaries are always co-rendered with a "read the source" link.
- **(Phase 9, reserved)** *Leaked API key used to scrape the paid endpoints.* Mitigation plan: store only `sha256(pepper || raw_key)` in the `api_keys` table, never the raw value; issue keys once and display once; expose a `/me/keys` rotation endpoint with atomic replace; alarm on any `tier≠free` request arriving from more than 3 distinct `/24` source IPs inside 1 hour (credential-sharing signal).

The threats we do **not** treat specially:

- DDoS beyond WAF rate limits. CloudFront absorbs transient spikes; if a state-actor DDoS arrives, we turn off `/v1/summarise` and `/v1/search` via a feature flag and leave static pages running.
- Nation-state infiltration of AWS eu-north-1. If that's happening, this project is not the priority.

### 3.2 IAM

One role per Lambda, least-privilege. A short list:

| Role | Permissions |
|---|---|
| `AgoraIngestRiksRole`      | `s3:PutObject` on `agora-raw/riks/*`; DynamoDB r/w on `ingest_cursors`, `ingestion_runs`; `states:StartExecution` on `fanout-doctext`; `logs:*` on own log group |
| `AgoraIngestEsvRole`       | `s3:PutObject` on `agora-raw/esv/*`; DynamoDB r/w on `ingest_cursors`, `ingestion_runs`; `logs:*` |
| `AgoraIngestManifestoRole` | `s3:PutObject` on `agora-raw/manifesto/*`; DynamoDB r/w on `ingest_cursors`, `ingestion_runs`; `secretsmanager:GetSecretValue` on the one manifesto-api-key ARN; `logs:*` |
| `AgoraTransformRole`       | `s3:GetObject` on `agora-raw/*`; `s3:PutObject/GetObject/DeleteObject` on `agora-parquet/*`; SQS send to the derive queue; `logs:*` |
| `AgoraDeriveRole`          | `s3:GetObject/PutObject/DeleteObject` on `agora-parquet/*`; `logs:*` |
| `AgoraEmbedRole`           | `s3:GetObject` on `agora-parquet/document_chunks/*`; `s3:PutObject` on `agora-parquet/document_embeddings/*`; `bedrock:InvokeModel` on the Titan Embed v2 model ARN; `logs:*` |
| `AgoraApiRole`             | `s3:GetObject` on `agora-parquet/*` and `agora-raw/doc-text/*`; DynamoDB r on `summary_cache`, `accountability_cache`, `accountability_jobs`; `logs:*` |
| `AgoraLlmReadRole`         | As `AgoraApiRole`, plus `bedrock:InvokeModel` on Haiku and Titan Embed ARNs; DynamoDB r/w on `summary_cache`; `logs:*` |
| `AgoraEnqueueRole`         | DynamoDB r/w on `accountability_cache`, `accountability_jobs`; SQS send on the accountability queue; `logs:*` |
| `AgoraLlmAccRole`          | As `AgoraLlmReadRole`, plus DynamoDB r/w on `accountability_cache`, `accountability_jobs`; SQS receive+delete on the accountability queue; `logs:*` |

No role has `s3:*`, `dynamodb:*`, or `bedrock:*`.

**Reserved for Phase 9 (commercial tier) — not created at MVP:**

| Role | Permissions |
|---|---|
| `AgoraAuthorizerRole` | DynamoDB r on `api_keys`; `secretsmanager:GetSecretValue` on `/agora/api_keys/pepper`; `logs:*`. Attached to the authorizer Lambda. |
| `AgoraKeyAdminRole`   | DynamoDB r/w on `api_keys`; `secretsmanager:GetSecretValue` on `/agora/stripe/*`; `logs:*`. Attached to the self-serve key-issuance Lambda. |

These two roles are defined in CDK behind the same `apiTiers=on` flag as the secrets above. The rate-limit throttling handler already in `AgoraApiRole` / `AgoraLlmReadRole` (which reads `principal_id`-keyed rows from `ratelimit_counter`) does not need modification when the paid tier ships — the permissions grant is already tight to that specific table.

### 3.3 Secrets

Two secrets in the system today, both in AWS Secrets Manager / SSM Parameter Store in the same account and region:

1. **`/agora/ops/alert_email`** (SSM Parameter Store, `SecureString`) — the maintainer's email address for SES delivery of the weekly digest and SNS alerts.
2. **`/agora/manifesto/api_key`** (Secrets Manager) — the Manifesto Project WZB API key. Read-only, single-purpose. Accessible only to `AgoraIngestManifestoRole`.

No Anthropic keys, no Voyage keys, no Supabase keys, no PostHog keys, no Sentry DSN, no Upstash tokens — the post-Supabase cut (`01-critical-review.md`) removes the services they belonged to.

**Reserved for Phase 9 (commercial tier) — not created at MVP:**

3. `/agora/stripe/secret_key` (Secrets Manager) — Stripe secret key for issuing keys and reading subscription state.
4. `/agora/stripe/webhook_signing` (Secrets Manager) — webhook signature secret.
5. `/agora/api_keys/pepper` (Secrets Manager) — 32-byte random pepper mixed into `api_keys` table hashes so a leaked table dump cannot be brute-forced.

These entries are *defined in the CDK code behind an `apiTiers=on` flag*; they are not provisioned at MVP. Enabling the flag creates empty secrets; a human populates them once, exactly as the manifesto key is populated today.

### 3.4 Data protection

- **At rest:** S3 buckets use SSE-S3 by default (free). The `agora-raw` bucket additionally uses versioning, letting us restore from accidental overwrites.
- **In transit:** HTTPS everywhere, TLS 1.2 minimum enforced by CloudFront and API Gateway. The Lambda-to-S3 path stays inside the AWS network.
- **Logs:** scrubbed of IPs beyond coarse `/24` aggregation for the CloudFront log pipeline (see 3.5).
- **Backups:** implicit. The `agora-parquet` bucket is derived; rebuildable from `agora-raw`. `agora-raw` is the only bucket that, if lost, is lost forever — hence its versioning and 3-year lifecycle retention.

### 3.5 CloudFront logs

Enabled, written to an `agora-logs` bucket. An overnight Lambda aggregates them into a daily Parquet summary (`date, url_path, status, country, requests`) and deletes the raw logs 24 hours later. This gives us enough signal for operational questions without retaining PII-equivalent per-request data.

## 4. WAF — rate limiting alternatives

The default configuration uses **AWS WAF** with a single rate-based rule (300 req per 5 min per IP), costing ~$5.60/mo. For strict coffee-budget runs we document a cheaper alternative here so future maintainers can flip it if cost becomes an issue.

### 4.1 Cheap alternative: CloudFront Function + DynamoDB counter

- A CloudFront Function runs at every edge request, calls a small Lambda@Edge-free "token bucket" via signed URL to an API Gateway endpoint backed by a DynamoDB TTL-counter.
- DynamoDB cost at modest traffic: a few cents/month.
- Downside: adds a few milliseconds of latency per request and more moving parts.

Choose WAF when you want the well-trodden path; choose the CF-Function variant when every dollar counts and you are comfortable with a custom component.

## 5. Privacy (citizen-facing)

Agora's privacy promise, in plain Swedish, will live on the `/om` page:

- Inga konton, ingen inloggning, inga tredjepartsspårare.
- Vi lagrar tillfälligt aggregerad statistik från webbservern för driftsändamål i högst 24 timmar, sedan raderas den.
- Allt innehåll om riksdagsledamöter är offentligt enligt offentlighetsprincipen och hämtas direkt från data.riksdagen.se.

And the `/om` page is *actually true* — that is the function of this document: to keep the promise a deployable artefact.
