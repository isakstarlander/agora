# PR-11 — `AgoraObsStack` (observability and cost control)

## Outcome

`AgoraObsStack` deployed: CloudWatch dashboard `AgoraOps`, SNS topic `agora-ops-alerts` with one email subscription, all alarms listed in `09-observability-and-security.md`, three AWS Budgets that publish to the same SNS topic, a weekly SES digest Lambda, and an SES domain identity for the digest sender. One maintainer email is notified on every breach.

## Roadmap anchor

`11-roadmap.md` — Phase 4 (2 days); `09-observability-and-security.md` §§1–3.

## Prerequisites

- PR-02 through PR-10 deployed; all the metrics the alarms watch are now being produced.
- `/agora/ops/alert_email` SSM parameter populated in PR-00.

## Context

Observability for Agora is deliberately small: one dashboard, one email recipient, a handful of alarms, three cost budgets, and a once-a-week digest. We are not Datadog customers; this is a civic-tech project where "page goes down overnight, fix in the morning" is an acceptable failure mode.

`09-observability-and-security.md` §1.2 lists the metrics emitted by earlier Lambdas. This PR only *wires* them. If any metric in the table below is missing from the system, file it as a regression against the originating PR — do not add CDK code to emit it here.

### Alarm inventory

| Alarm | Metric (namespace `Agora`) | Threshold | Window | Source PR |
|---|---|---|---|---|
| `IngestErrorsHigh` | `IngestErrors` | ≥ 3 | 1 h | PR-03 / PR-05 |
| `TransformErrorsHigh` | `TransformErrors` | ≥ 1 | 1 h | PR-06 |
| `TransformDlqNonEmpty` | `ApproximateNumberOfMessagesVisible` on DLQ | ≥ 1 | 5 min | PR-06 |
| `DeriveErrorsHigh` | `DeriveErrors` | ≥ 1 | 1 h | PR-07 |
| `DeriveDlqNonEmpty` | DLQ depth | ≥ 1 | 5 min | PR-07 |
| `ApiLatencyP95High` | `ApiLatencyMs` (p95 stat) | > 2000 ms | 5 min | PR-08 |
| `ApiErrors5xxHigh` | `ApiErrors5xx` | ≥ 5 | 5 min | PR-08 |
| `AccountabilityJobDurationP95High` | `AccountabilityJobDurationMs` (p95) | > 15000 ms | 15 min | PR-14 |
| `AccountabilityJobFailuresHigh` | `AccountabilityJobFailures` | ≥ 3 | 1 h | PR-14 |
| `WafRateLimitBurst` | `RateLimitIp` blocked requests (WAF) | ≥ 100 | 5 min | PR-10 |
| `CloudFrontErrorRateHigh` | `5xxErrorRate` | > 1 % | 15 min | PR-10 |
| `DoctextFetchFailures` | `DoctextFetchFailures` | ≥ 5 | 1 h | PR-04 |
| `DeadletterAgingTransform` | `ApproximateAgeOfOldestMessage` on DLQ | > 3600 s | 15 min | PR-06 |
| `DeadletterAgingAccountability` | DLQ age | > 3600 s | 15 min | PR-14 |
| `BedrockMonthlyTokenCap` | `LlmTokensInput` cumulative (per month) | ≥ 10M | monthly | PR-13 / PR-14 |

All alarms publish to `agora-ops-alerts`.

Alarms for PRs 13 / 14 exist in this PR's CDK code but are **noop** until those PRs ship the metrics. The stack synth must not fail when the metrics don't yet exist — CloudWatch alarms are happy to watch a not-yet-emitted metric (they just show `INSUFFICIENT_DATA`).

## Scope / Deliverables

### 1. SNS topic + email subscription

```ts
const alertsTopic = new sns.Topic(this, "AgoraOpsAlerts", {
  topicName: "agora-ops-alerts",
  displayName: "Agora ops alerts",
});
const alertEmail = ssm.StringParameter.valueForStringParameter(this, "/agora/ops/alert_email");
new sns.Subscription(this, "AlertEmailSub", {
  topic: alertsTopic,
  endpoint: alertEmail,
  protocol: sns.SubscriptionProtocol.EMAIL,
});
```

The first `cdk deploy` sends a confirmation email. Subscription remains `PendingConfirmation` until the user clicks the link — this is an expected manual step.

### 2. CloudWatch dashboard

Named `AgoraOps`, six widgets per `09-observability-and-security.md` §1.3:

1. **API health**: RPS & p95 latency from `ApiLatencyMs`, `ApiRequests`.
2. **Ingest health**: `IngestNewDocs` per source, `IngestErrors` counts.
3. **Transform health**: `TransformErrors`, DLQ depth, run duration histogram.
4. **LLM usage**: `LlmTokensInput`, `LlmTokensOutput`, `AccountabilityJobDurationMs`.
5. **WAF hits**: `RateLimitIp` blocked count.
6. **Cost forecast**: an `MetricMath` widget pulling `AWS/Billing:EstimatedCharges` + a Budgets widget.

Use `aws_cloudwatch.Dashboard` with typed `GraphWidget` objects.

### 3. Alarms

One `cloudwatch.Alarm` per table row. Each alarm has:

- `alarmName: "agora-<name>"`
- `evaluationPeriods` sized per the window
- `datapointsToAlarm` = evaluation periods
- `treatMissingData: TreatMissingData.NOT_BREACHING` (no metric = healthy)
- `addAlarmAction(new cw_actions.SnsAction(alertsTopic))`

Encapsulate the per-alarm config in `iac/lib/constructs/alarm-factory.ts` so that adding a new one is a single call.

### 4. AWS Budgets

`budgets.CfnBudget` for each of 20, 30, 50 USD (actual) and one 75 USD forecast-based alarm that piggybacks on the 50 USD budget:

```ts
const makeBudget = (amount: number, threshold: budgets.CfnBudget.NotificationProperty[]) =>
  new budgets.CfnBudget(this, `Budget${amount}`, {
    budget: {
      budgetName: `agora-budget-${amount}usd`,
      budgetType: "COST",
      timeUnit: "MONTHLY",
      budgetLimit: { amount, unit: "USD" },
    },
    notificationsWithSubscribers: threshold.map(n => ({
      notification: n,
      subscribers: [{ subscriptionType: "SNS", address: alertsTopic.topicArn }],
    })),
  });
```

Note: AWS Budgets SNS notifications require the topic policy to allow `budgets.amazonaws.com`. Add that permission to the topic.

PR-00 created these via the console for the benefit of the account's owner; this PR **replaces** the console-created budgets with CDK-managed ones so drift is controlled. The console ones can be deleted after CDK takes over (verify no gap in notifications).

### 5. SES domain identity

Required to send the weekly digest email:

```ts
const sesDomain = new ses.EmailIdentity(this, "OpsSenderIdentity", {
  identity: ses.Identity.domain(ctx.domain ?? "agora.local"),
});
```

If no custom domain (`ctx.domain` unset) use the default verified email-address identity:

```ts
new ses.EmailIdentity(this, "OpsSenderEmail", {
  identity: ses.Identity.email(alertEmail),
});
```

SES starts in sandbox mode (can only send to verified recipients). That is sufficient for the single-maintainer digest.

### 6. Weekly digest Lambda

Node 20 ARM64, `iac/lambda/weekly-digest/src/index.ts`. Runs Monday 05:00 UTC (07:00 Stockholm) via EventBridge rule:

- Reads the previous 7 days from CloudWatch metrics: `IngestNewDocs`, `ApiRequests`, `ApiLatencyMs` (p95), `LlmTokensInput`, `AccountabilityJobFailures`, any firing alarms.
- Reads AWS Cost Explorer: month-to-date cost breakdown.
- Composes a concise Markdown email body.
- Sends via SES.

Memory: 256 MB. Timeout: 1 min. IAM: `cloudwatch:GetMetricData`, `cloudwatch:DescribeAlarms`, `ce:GetCostAndUsage`, `ses:SendEmail` scoped to the identity.

### 7. Per-service cost guards

Expose two SSM parameters that the LLM Lambdas (PR-13 / PR-14) read to decide whether to short-circuit:

- `/agora/llm/enabled` — `"true"` or `"false"`. Hard kill switch.
- `/agora/llm/monthly_token_cap` — integer (default `10000000`).

`AgoraObsStack` creates these with default values. The Bedrock-token-cap alarm reads the same values via a metric math expression (`LlmTokensInput.sum / param`) to alarm when 80 % consumed.

### 8. Ops alarm email hygiene

If the alarm frequency exceeds "acceptable" (e.g. >5 emails / day), the maintainer should adjust thresholds. This is noted in the `iac/README.md` operator cheat-sheet.

### 9. Tests

- Snapshot test on the stack; assert alarm count matches the table above.
- Integration: after deploy, send `aws cloudwatch set-alarm-state --alarm-name agora-ApiErrors5xxHigh --state-value ALARM --state-reason "test"`; confirm an email arrives.

## Manual steps

1. **Confirm the SNS email subscription.** First `cdk deploy AgoraObsStack` sends a confirmation email from `no-reply@sns.amazonaws.com`; click the "Confirm subscription" link. Until confirmed, no alarm emails reach the maintainer.
2. **Verify SES sender identity.** AWS emails the sender address (or publishes DNS records for the sender domain). For domain identities, add the DKIM CNAME records AWS provides to the Route 53 zone (if using a custom domain). For email identities, click the "Verify" link in AWS's email.
3. **Replace the console-created AWS Budgets** from PR-00 with the CDK-created ones (either delete the console ones after confirming CDK ones fire a test alarm, or leave both in place — the second confirmation email is harmless).
4. **Trigger a synthetic alarm** once to confirm the full path works:

   ```bash
   aws cloudwatch set-alarm-state \
     --profile agora-se --region eu-north-1 \
     --alarm-name agora-ApiErrors5xxHigh \
     --state-value ALARM --state-reason "smoke test"
   ```

   An email should arrive within 60 s. Run the same with `--state-value OK` afterwards.

## Acceptance criteria

- [ ] `cdk deploy AgoraObsStack` exits 0.
- [ ] SNS topic `agora-ops-alerts` has a confirmed email subscription.
- [ ] CloudWatch dashboard `AgoraOps` exists with all 6 widgets.
- [ ] All 15 alarms from the table exist with the right thresholds (verify via `aws cloudwatch describe-alarms --alarm-name-prefix agora-`).
- [ ] Three AWS Budgets (20 / 30 / 50 USD) exist and publish to `agora-ops-alerts`.
- [ ] The synthetic alarm test in manual step 4 produces an email within 60 s.
- [ ] The weekly digest Lambda is scheduled for Monday 05:00 UTC.
- [ ] Manually invoking the digest Lambda (`aws lambda invoke --function-name agora-weekly-digest out.json`) sends an email with real metrics within 30 s.
- [ ] SSM parameters `/agora/llm/enabled=true` and `/agora/llm/monthly_token_cap=10000000` exist.

## Out of scope

- Distributed tracing (X-Ray) — disabled project-wide per `09-observability-and-security.md`. Revisit if debugging calls for it.
- Shipping logs to third-party log aggregators. CloudWatch is the system of record.
- A PagerDuty or Opsgenie integration. Email-only.
- Per-customer usage reports (Phase 9 / PR-17).
- Fine-grained SLO tracking beyond the alarms in the table. Civic-tech project; this is enough.
