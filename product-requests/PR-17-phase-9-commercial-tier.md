# PR-17 — Phase 9 commercial API tier (optional, post-launch)

## Outcome

With `-c agora:apiTiers=on`, `AgoraApiStack` provisions a Lambda authorizer + `agora_api_keys` DynamoDB table + `key-admin` Lambda with four endpoints, and wires Stripe for billing. Free-tier anonymous traffic continues to work identically; paid tiers (`hobby`, `press`, `enterprise`) are enforced by the authorizer's returned `rate_limit_rpm` and `monthly_quota`. A `/dev` dashboard lets developers subscribe via Stripe Checkout, issue keys, and view usage. A monthly usage-report Lambda emails each paying customer a CSV of their consumption. **No data changes** between tiers — paid means more requests and better support, not different bytes (`00-foundation.md` §3).

## Roadmap anchor

`11-roadmap.md` — Phase 9 (≈ 2 weeks); `06-storage-and-api.md` §7.

## Prerequisites

- All three Phase 9 pre-conditions from `11-roadmap.md` hold:
  1. Free-tier dashboard live ≥ 3 months with no open data-correctness complaints.
  2. ≥ 3 external parties have unprompted-asked if they can rely on the API.
  3. Maintainer has capacity for 1–2 business-day email response SLA.
- Stripe account set up; Stripe test-mode and live-mode API keys available.
- `/agora/api_keys/pepper` and `/agora/stripe/webhook_secret` and `/agora/stripe/api_key` secrets empty entries exist in Secrets Manager (created in PR-02).

## Context

The API was designed forward-compatibly in PR-08: the handlers already branch on `principal_id` and a `tier` from the authorizer context; EMF metrics are dimensioned on `tier`; JSON envelopes are stable; OpenAPI is generated. This PR **flips the preserved switch** rather than rewriting anything.

Architectural invariants this PR holds:

1. **Public data stays public.** Every `/v1` route that responds to an anonymous caller continues to respond to anonymous callers with the same bytes. Paying customers receive the same bytes; they just get more requests per minute and human support.
2. **The free tier is not regressed.** Rate limits, payload shapes, cache behaviour, and error shapes for anonymous callers are byte-identical before and after.
3. **No bulk-data firewall.** Bulk analytical access lives on `s3://agora-parquet-pub/` as a requester-pays mirror (separate PR if ever built); the paid API does not compete with it.
4. **Reversible.** Flipping `-c agora:apiTiers=off` restores the MVP state (authorizer stubbed to always-pass, tables unused). A rollback does not orphan customer data — the `agora_api_keys` table is retained.

Tier table (`11-roadmap.md` §9):

| Tier | Rate limit | Monthly quota | Price | Target |
|---|---|---|---|---|
| `free` | 20 req/min/IP | — | — | Citizens, occasional scripts |
| `hobby` | 120 req/min | 500 k / mo | ~€19 / mo | Solo journalists, students |
| `press` | 600 req/min | 5 M / mo | ~€99 / mo | Newsrooms, polling firms |
| `enterprise` | negotiated | negotiated | negotiated | Public-sector consultancies |

## Scope / Deliverables

### 1. `agora_api_keys` DynamoDB table

```
pk: key_hash (STRING)   // sha256(raw_key + pepper)[:32]
Attrs:
  tier:                 STRING  // "hobby" | "press" | "enterprise"
  active:               BOOL
  owner_email:          STRING
  stripe_customer_id:   STRING
  stripe_subscription_id: STRING
  rate_limit_rpm:       NUMBER
  monthly_quota:        NUMBER
  monthly_used:         NUMBER  // reset at month rollover via the usage-report Lambda
  scopes:               SS      // string set, e.g. ["read:documents", "read:votes", "admin"]
  created_at:           STRING  // ISO 8601
  last_used_at:         STRING
```

Billing mode on-demand. Point-in-time recovery on (support case: recover a revoked key).

### 2. Lambda authorizer

`iac/lambda/authorizer/src/handler.py` (Python 3.12, 512 MB, 5 s timeout, authoriser type `REQUEST` with identity source `Authorization` header):

```python
def handler(event, _ctx):
    auth = event.get("headers", {}).get("authorization", "")
    if not auth.startswith("Bearer "):
        # anonymous: preserve free-tier behaviour
        ip = event["requestContext"]["http"]["sourceIp"]
        return allow({
            "principal_id": f"ip#{ip}",
            "tier": "free",
            "rate_limit_rpm": 20,
            "monthly_quota": 0,  # 0 = unbounded free tier
            "scopes": ["read:public"],
        })

    raw = auth.removeprefix("Bearer ").strip()
    key_hash = sha256(raw + PEPPER)[:32]
    row = ddb.get_item(Table="agora_api_keys",
                       Key={"key_hash": {"S": key_hash}}).get("Item")
    if not row or row.get("active", {}).get("BOOL") is not True:
        return deny()

    update_last_used(key_hash)
    return allow({
        "principal_id": f"key#{key_hash[:16]}",
        "tier": row["tier"]["S"],
        "rate_limit_rpm": int(row["rate_limit_rpm"]["N"]),
        "monthly_quota": int(row["monthly_quota"]["N"]),
        "owner_email": row["owner_email"]["S"],
        "scopes": list(row["scopes"]["SS"]),
    })
```

Authorizer result TTL 60 s (API Gateway caches). This bounds key-revocation latency to 60 s — documented on the `/dev` page.

### 3. Handler update

The `api`, `llm-read`, `llm-acc`, and `enqueue-accountability` Lambdas read `principal_id`, `tier`, `rate_limit_rpm`, `monthly_quota` from `event["requestContext"]["authorizer"]["lambda"]`. They were already written against these names in PR-08 / PR-13 / PR-14 — this PR does not change handler logic, only the authorizer that supplies the values.

Rate-limit check in `agora_ratelimit_counter` uses `principal_id` and `rate_limit_rpm` as before. The `monthly_quota` check is new:

```python
used = ddb.update_item(
    TableName="agora_api_keys",
    Key={"key_hash": {"S": key_hash_from_principal(principal_id)}},
    UpdateExpression="ADD monthly_used :one",
    ExpressionAttributeValues={":one": {"N": "1"}},
    ReturnValues="UPDATED_NEW",
)["Attributes"]["monthly_used"]["N"]
if int(used) > monthly_quota > 0:
    return problem(429, "Månadskvot överskriden")
```

This runs only for non-anonymous callers (anonymous `tier=free` has `monthly_quota=0` → check skipped).

### 4. `key-admin` Lambda

Four routes, all behind the authorizer with `scopes` containing either `admin` or `owner`:

- `POST /v1/stripe/webhook` — no authorizer (Stripe signs the request; verify `Stripe-Signature` in the handler using `webhook_secret`). On `customer.subscription.created/updated`, upsert the `agora_api_keys` row (but do not issue a key — the customer does that via `/me/keys`). On `customer.subscription.deleted`, set `active=false`.
- `POST /v1/me/keys` — authorizer requires `tier in {hobby, press, enterprise}`. Body: `{name, scopes}`. Generate `raw = secrets.token_urlsafe(32)`; compute `key_hash`; write row with the signed-in user's Stripe customer id. Return `{raw_key, key_hash, name}` **once only**.
- `GET /v1/me/keys` — list rows for the user's Stripe customer id (metadata only; never echo `raw`).
- `DELETE /v1/me/keys/{key_hash}` — set `active=false`.

The `me` routes are gated by a minimal OIDC-style flow. MVP option: **Stripe Customer Portal** as the only identity system. The `/dev` page embeds the Customer Portal; on completion Stripe redirects back with a short-lived signed token that the `key-admin` Lambda exchanges for the Stripe customer id. This avoids adding Cognito.

Alternative if Stripe Customer Portal proves insufficient: add AWS Cognito User Pools in a separate PR.

### 5. Stripe integration

Checkout flow:

1. `/dev/subscribe?tier=hobby` server-side redirects to a Stripe Checkout session (created via `stripe.checkout.Session.create(...)`), `mode="subscription"`, `success_url=/dev/keys?success=1`, `cancel_url=/dev/subscribe`. Prices are Stripe Price IDs stored in `/agora/stripe/price_ids` SSM parameter.
2. On successful checkout, Stripe webhook `customer.subscription.created` fires and updates the `agora_api_keys` row for this customer.
3. User lands on `/dev/keys?success=1` and can press "Issue new key".

Webhook receipt verification (mandatory):

```python
sig = event["headers"]["stripe-signature"]
payload = event["body"]  # raw, unparsed
try:
    evt = stripe.Webhook.construct_event(payload, sig, WEBHOOK_SECRET)
except stripe.error.SignatureVerificationError:
    return problem(400, "Bad signature")
```

### 6. `/dev` dashboard page

New Next.js route `web/app/[locale]/dev/`:

- `/sv/dev/` — landing with tier table, pricing, and "Sign in with Stripe".
- `/sv/dev/keys/` — list keys, issue / revoke, show this-month usage.
- `/sv/dev/priser/` — marketing page; identical to `/sv/priser/` which is public.

The Stripe Customer Portal link is embedded as an `<iframe>` on `/dev/keys/`.

Swedish + English strings; no new shadcn components needed.

### 7. `/priser` page

Public-facing pricing page. Markdown content in `web/content/priser.sv.md` + `.en.md`. Prices are **illustrative** and marked as such — the exact values are a business decision.

Content outline:

- Headline: "En öppen datakälla + en betald kanal för dig som integrerar mot oss."
- Three-column table (Hobby / Press / Enterprise) with rate limit, monthly quota, support response time, price.
- A "Varför kostar det pengar?" paragraph that explicitly states paid tier buys SLA + throughput, not data (data is public).
- Link to `/sv/dev/`.

### 8. Monthly usage report Lambda

`iac/lambda/usage-report/` Python Lambda. EventBridge rule `agora-usage-report-monthly`, cron `cron(0 6 1 * ? *)` (first of each month 06:00 UTC).

Flow:

1. Scan `agora_api_keys` where `tier != "free"` and `active=true`.
2. For each, query CloudWatch `ApiRequests` metric with `dim={principal_id: "key#…", tier: "…"}` over the previous month.
3. Compose a CSV: `(day, route, tier, count)`.
4. Send via SES to `owner_email`.
5. Reset `monthly_used` to 0 on the key row.

SES is in sandbox mode (PR-11) — for Phase 9 this must be moved out of sandbox. The CDK config bumps to production SES when `-c agora:apiTiers=on`. AWS requires a written use-case; the form is one page.

### 9. IAM

`AgoraAuthorizerRole`:
- `dynamodb:GetItem`, `UpdateItem` on `agora_api_keys`.
- `secretsmanager:GetSecretValue` on `/agora/api_keys/pepper`.

`AgoraKeyAdminRole`:
- `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `Query` on `agora_api_keys` (GSI by `stripe_customer_id`).
- `secretsmanager:GetSecretValue` on `/agora/api_keys/pepper`, `/agora/stripe/api_key`, `/agora/stripe/webhook_secret`.

`AgoraUsageReportRole`:
- `dynamodb:Scan`, `UpdateItem` on `agora_api_keys`.
- `cloudwatch:GetMetricData`.
- `ses:SendEmail` scoped to the sender identity.

### 10. Alarms

Enable (were defined in PR-11 with noop dimension values):

- `ApiRequests` tier-dimensioned alarms: alert when `tier=press` RPS suddenly drops >80% (customer outage impact).
- `ApiPrincipalThrottles{tier=press}` alert when > 10 / h (a customer is hitting their limit often — sales/support opportunity).

### 11. OpenAPI

Regenerate `s3://agora-web/openapi/v1.json`. The spec gains:

- `securitySchemes.bearerAuth`: HTTP Bearer authentication.
- `security: [{ bearerAuth: [] }]` on every route that is callable anonymously and may be authenticated.
- New routes: `POST /v1/me/keys`, `GET /v1/me/keys`, `DELETE /v1/me/keys/{key_hash}`, `POST /v1/stripe/webhook`.
- Response header documentation: `X-Tier`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

### 12. Feature flag

CDK context:

```ts
const apiTiersEnabled = this.node.tryGetContext("agora:apiTiers") === "on";
```

If `off`, none of the above resources are created, the authorizer remains the no-op from PR-08, and the `/dev` pages return a 404. The cutover PR was shipped at `off`; Phase 9 PR is literally just "flip the flag + provide the `key-admin` Lambda code + deploy".

### 13. Tests

- Unit: authorizer — anonymous, valid key, revoked key, wrong-scope key.
- Unit: monthly quota check — under, at, over.
- Integration: webhook — fake Stripe signature → 400; valid signature on `customer.subscription.created` → row written.
- Integration: `/v1/me/keys` round-trip — issue → use → revoke → 401 within 60 s.
- Smoke: drive 121 req/min with a `tier=hobby` key; assert 429 on the 121st.

## Manual steps

1. **Satisfy Phase 9 pre-conditions** before starting any code. If any of the three from `11-roadmap.md` §9 is not met, stop.
2. **Stripe account.** Create a Stripe account dedicated to Agora. Create three products (Hobby / Press / Enterprise) with monthly prices in EUR. Record the Price IDs.
3. **Populate secrets.**

   ```bash
   aws secretsmanager put-secret-value \
     --secret-id /agora/api_keys/pepper \
     --secret-string $(openssl rand -base64 32)

   aws secretsmanager put-secret-value \
     --secret-id /agora/stripe/api_key \
     --secret-string sk_live_XXXXXXXXXXXXXXXXXXXXXXXX

   aws secretsmanager put-secret-value \
     --secret-id /agora/stripe/webhook_secret \
     --secret-string whsec_XXXXXXXXXXXXXXXXXXXXXX

   aws ssm put-parameter --name /agora/stripe/price_ids \
     --type String \
     --value '{"hobby":"price_…","press":"price_…","enterprise":"price_…"}'
   ```

4. **Move SES out of sandbox.** Submit the AWS support case; approval is typically 24 h. Until approved, paid-tier usage reports silently 503; free tier is unaffected.
5. **Configure Stripe webhook.** In Stripe Dashboard, add endpoint `https://<domain>/v1/stripe/webhook` for events `customer.subscription.created/updated/deleted`, `invoice.payment_failed`. Copy the signing secret into `/agora/stripe/webhook_secret`.
6. **Deploy with the flag on.**

   ```bash
   cd iac
   npx cdk deploy AgoraApiStack -c agora:apiTiers=on --profile agora-se
   ```

7. **Seed a test customer.** Use Stripe Checkout in test mode; verify a `agora_api_keys` row lands; issue a key via `/dev/keys`; hit `/v1/documents` with `Authorization: Bearer <raw>`; verify `X-Tier: hobby` in the response.
8. **Switch Stripe to live mode** only after the end-to-end test-mode flow has succeeded at least three times across three browsers.
9. **Publish `/sv/priser/`** on the next web deploy.
10. **Announce.** To the three external parties who unprompted-asked for the API, send a plain-text email with the `/sv/priser/` link and one paragraph on limits / SLA / support response time.

## Acceptance criteria

- [ ] `cdk deploy AgoraApiStack -c agora:apiTiers=on` exits 0.
- [ ] Anonymous `GET /v1/documents` returns the same bytes as before the flag flip, with `X-Tier: free`.
- [ ] `POST /v1/me/keys` with a valid signed-in user issues a key; `GET /v1/me/keys` lists it; `DELETE /v1/me/keys/{hash}` revokes it.
- [ ] A call using the issued key within 60 s of revocation returns `401`.
- [ ] A `tier=hobby` client is allowed 120 req/min and throttled on req #121 within the same minute.
- [ ] A `tier=hobby` client that has consumed `monthly_quota` is throttled with `429` including an `X-RateLimit-Reset` header indicating the month rollover.
- [ ] A Stripe webhook for a **faked** signature returns `400`.
- [ ] A monthly usage-report Lambda invocation sends a CSV email to each of three seeded paying customers with at least one row of data.
- [ ] The `/sv/priser/` page renders with three tiers, prices, and a link to `/sv/dev/`.
- [ ] OpenAPI at `/openapi/v1.json` documents `/me/keys` and `bearerAuth` security scheme.
- [ ] Flipping `-c agora:apiTiers=off` and re-deploying returns the stack to the MVP state (authorizer no-op; anonymous callers unaffected).

## Out of scope

- A free-tier ad-hoc key (e.g. "register an email for 1000 free requests/day"). Keeps the free tier pure-anonymous.
- Usage-based billing. Per `11-roadmap.md` §9 the paid tiers are subscription-based; metered billing is a post-Phase-9 feature if customer demand shows up.
- Cognito or a custom identity system. Stripe Customer Portal is the only identity surface at MVP Phase 9.
- Role-based access beyond `admin` / `owner` / `read:*`. A single scope set is enough for the four named tiers.
- A programmatic `POST /v1/subscriptions` — subscribe is a browser-only flow via Stripe Checkout.
- Multi-region. Same single-region posture as the rest of Agora.
- Data-access tier differentiation. Explicitly rejected (`11-roadmap.md` §9 non-goals).
