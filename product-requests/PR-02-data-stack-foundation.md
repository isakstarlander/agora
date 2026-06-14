# PR-02 — `AgoraDataStack` foundation

## Outcome

`AgoraDataStack` provisioned with all **storage** resources needed for the ingestion and query layers: three S3 buckets (`agora-raw`, `agora-parquet`, `agora-logs`), six DynamoDB tables, one EventBridge scheduler group, one empty Secrets Manager entry for the Manifesto Project API key, a Glue Data Catalog database, and the IAM scaffolding that future Lambdas will assume. **No Lambdas yet** — this PR is pure state.

## Roadmap anchor

`11-roadmap.md` — Phase 1, infra half of step 1; `10-iac-bootstrap.md` §3.1 (minus compute).

## Prerequisites

- PR-01 complete. Five empty stacks deploy cleanly.
- PR-00's Manifesto Project API key **emailed** (not yet in AWS).

## Context

Agora's analytical storage is a **Parquet-on-S3 lake**, queried by DuckDB from Lambdas (PR-08+). Its mutable storage is a small set of **DynamoDB on-demand tables** sized in the hundreds of rows, not the hundreds of thousands. No hosted Postgres, ever.

The raw bucket is the source-of-truth mirror of every external feed; a full rebuild of every Parquet partition can always be re-driven from it. It is **versioned** and retains data for 3 years. The parquet bucket is versioned and retained indefinitely. The web bucket lives in `AgoraWebStack` (PR-10), not here.

The full S3 layout we will produce (for reference — most prefixes are created by Lambdas in later PRs, not here):

```
agora-raw-<account>/
  riks/dokumentlista/doktyp={mot|prop|bet|skr|ip|fr}/ingested=<ISO-slug>/{page-NNN.json.gz, manifest.json}
  riks/voteringlista/rm=<YYYY-YY>/ingested=<ISO-slug>/{part-NNN.json.gz, manifest.json}
  riks/anforandelista/rm=<YYYY-YY>/ingested=<ISO-slug>/{part-NNN.json.gz, manifest.json}
  riks/personlista/ingested=<ISO-slug>/{full.json.gz, manifest.json}
  riks/dokument-detail/<dok_id>.json.gz
  riks/document-text/<dok_id>.txt.gz
  statskontoret/arsutfall/year=<YYYY>/ingested=<ISO-slug>/{raw.csv.gz, manifest.json}
  manifesto/<party_code>/election=<YYYY>/ingested=<ISO-slug>/{statements.json.gz, manifest.json}

agora-parquet-<account>/
  members/                                     (PR-06)
  documents/doktyp=*/year=*/                   (PR-06)
  document_authors/                            (PR-06)
  votes/year=*/                                (PR-06)
  vote_results/year=*/                         (PR-06)
  votes_wide/year=*/                           (PR-07)
  speeches/year=*/                             (PR-06)
  budget_outcomes/year=*/                      (PR-06)
  manifestos/                                  (PR-06)
  manifesto_statements/                        (PR-06)
  document_chunks/doktyp=*/                    (PR-06)
  document_embeddings/                         (PR-12)
  party_cohesion/, party_divergence/,
  attendance_monthly/, motion_throughput/,
  speech_monthly/, budget_by_area/,
  manifesto_by_category/                       (PR-07)

agora-logs-<account>/
  cloudfront/                                  (PR-10)
  ingestion/                                   (PR-03+)
  transform/                                   (PR-06)
```

We create the **buckets** now; the prefixes are populated by later PRs. DynamoDB tables are created now because they are cheap and the downstream IAM roles that need to grant access to them are cleaner when the tables exist up-front.

## Scope / Deliverables

All edits go into `iac/lib/data-stack.ts` unless otherwise noted. No Lambda code in this PR.

### 1. Three S3 buckets

Create using `aws_s3.Bucket` with the following properties:

| Bucket | Logical id | Name pattern | Versioning | Public access | Lifecycle | Server-side encryption |
|---|---|---|---|---|---|---|
| Raw    | `RawBucket`     | `agora-raw-${accountId}`     | Enabled | Block-all-public | IA at 90 d; Glacier at 365 d; delete at 1095 d | `S3_MANAGED` |
| Parquet| `ParquetBucket` | `agora-parquet-${accountId}` | Enabled | Block-all-public | IA at 180 d; no expiration | `S3_MANAGED` |
| Logs   | `LogsBucket`    | `agora-logs-${accountId}`    | Disabled| Block-all-public | Expire all at 90 d | `S3_MANAGED` |

`removalPolicy` for `RawBucket` and `ParquetBucket` is `RETAIN`; `autoDeleteObjects` is `false`. `LogsBucket` uses `RemovalPolicy.DESTROY` with `autoDeleteObjects: true` — logs are disposable by design.

Enable **S3 event notifications** on `RawBucket` for `OBJECT_CREATED_PUT` filtered to `suffix=manifest.json`, targeting an SNS topic `agora-raw-manifests` that we create in this stack. PR-06's transform Lambda subscribes to that topic. Using SNS instead of a direct Lambda target keeps the stack boundary clean (`AgoraDataStack` owns the event source; PR-06 only adds a subscription).

Export `rawBucket`, `parquetBucket`, `logsBucket`, and `rawManifestTopic` as public readonly properties on the stack class so other stacks (`AgoraApiStack`, `AgoraLlmStack`) can read-grant against them via cross-stack references.

### 2. Six DynamoDB tables

All tables use `BillingMode.PAY_PER_REQUEST`, `encryption: AWS_MANAGED`, and `pointInTimeRecovery: false` (data is either derivable or short-lived).

| Logical id | Table name | PK | SK | TTL attr | Purpose |
|---|---|---|---|---|---|
| `IngestCursorsTable` | `agora_ingest_cursors` | `source_stream` (S) | — | — | Last-seen id per `(source, typ, rm)` |
| `IngestionRunsTable` | `agora_ingestion_runs` | `source` (S) | `run_id` (S) | `expires_at` | 180-day audit log of every ingestion run |
| `SummaryCacheTable` | `agora_summary_cache` | `dok_id_model` (S) | — | `expires_at` | Document summaries (365-day TTL) |
| `AccountabilityCacheTable` | `agora_accountability_cache` | `party_topic_period` (S) | — | `expires_at` | Accountability-synthesis cache (7-day TTL) |
| `AccountabilityJobsTable` | `agora_accountability_jobs` | `job_id` (S) | — | `expires_at` | Async job state (24-hour TTL) |
| `RatelimitCounterTable` | `agora_ratelimit_counter` | `principal` (S) | `window_start` (N) | `expires_at` | Per-IP/per-key throttle counter |

Apply `removalPolicy: RETAIN` to `IngestCursorsTable` only — accidentally destroying cursors causes a full ~30 GB refetch from upstream. All other tables are `DESTROY` (derivable).

Export the tables as readonly properties.

### 3. Glue Data Catalog database

Create `glue.CfnDatabase` named `agora_parquet` in `eu-north-1`. Later PRs register tables here so Athena can query the same files DuckDB sees. No tables in this PR.

### 4. Secrets Manager entry (empty)

Using the `SecretWrapper` construct from PR-01:

```ts
const manifestoKey = new SecretWrapper(this, "ManifestoApiKey", {
  secretName: "/agora/manifesto/api_key",
  description: "Manifesto Project WZB API key. Populated manually post-deploy.",
});
```

No generated value. The CDK deploy creates an empty SecretsManager secret; its value is inserted by hand in the manual-step section.

Export `manifestoKey` as a readonly property.

### 5. EventBridge scheduler group

Create `scheduler.CfnScheduleGroup` named `agora-schedules`. Every schedule in later PRs lives in this group, so listing `agora`'s scheduled activity is a single `aws scheduler list-schedules --group-name agora-schedules` call.

### 6. SNS topic for raw manifests

`sns.Topic` named `agora-raw-manifests` — receives S3 `OBJECT_CREATED` events for `manifest.json` suffixes on `RawBucket`. No subscriptions yet (PR-06 adds one).

### 7. IAM: `AgoraBaseLambdaRole`

A shared managed policy, not a role. It scopes the minimum permissions a Lambda in Agora needs beyond its default execution role:

- `xray:PutTraceSegments`, `xray:PutTelemetryRecords` — no-ops unless X-Ray is turned on but included to avoid drift on flip.
- `cloudwatch:PutMetricData` scoped to `Namespace=Agora`.

Export the policy as `baseLambdaPolicy`. Later PRs attach it to every function role.

### 8. Outputs

Add `CfnOutput` for:

- `RawBucketName`, `ParquetBucketName`, `LogsBucketName`
- `RawManifestTopicArn`
- All six DynamoDB table names
- `GlueDatabaseName`
- `ManifestoSecretArn`
- `ScheduleGroupName`

These outputs make it easy to set env vars in local runs and to assert resource existence in CI smoke tests.

### 9. CDK tests

Extend `iac/test/snapshot.test.ts` to include assertions beyond the snapshot:

```ts
import { Template, Match } from "aws-cdk-lib/assertions";

// DataStack provisions exactly three S3 buckets.
tmpl.resourceCountIs("AWS::S3::Bucket", 3);
// DataStack provisions exactly six DynamoDB tables.
tmpl.resourceCountIs("AWS::DynamoDB::Table", 6);
// Every table has TTL enabled except IngestCursorsTable.
tmpl.resourcePropertiesMatches(
  "AWS::DynamoDB::Table",
  Match.objectLike({ TimeToLiveSpecification: { AttributeName: "expires_at", Enabled: true } })
);
// ParquetBucket is Retained.
tmpl.hasResource("AWS::S3::Bucket", Match.objectLike({
  DeletionPolicy: "Retain",
  Properties: Match.objectLike({ BucketName: Match.stringLikeRegexp("agora-parquet-") }),
}));
```

## Manual steps

After `cdk deploy AgoraDataStack`:

1. **Populate the Manifesto Project API key** from the email received in PR-00:

   ```bash
   aws secretsmanager put-secret-value \
     --profile agora-se --region eu-north-1 \
     --secret-id /agora/manifesto/api_key \
     --secret-string "$(cat <<'JSON'
   { "api_key": "<paste-key-here>" }
   JSON
   )"
   ```

   The JSON shape is `{"api_key": "<string>"}`. Consumers read only the `api_key` field.

2. (Optional) Verify S3 block-public-access is on:

   ```bash
   aws s3api get-public-access-block \
     --profile agora-se --region eu-north-1 \
     --bucket agora-parquet-<account-id>
   ```

   All four fields should be `true`.

## Acceptance criteria

- [ ] `npx cdk deploy AgoraDataStack --profile agora-se` exits 0.
- [ ] AWS console shows 3 S3 buckets in `eu-north-1` named as specified, all with block-all-public-access enabled.
- [ ] `agora_ingest_cursors`, `agora_ingestion_runs`, `agora_summary_cache`, `agora_accountability_cache`, `agora_accountability_jobs`, `agora_ratelimit_counter` exist, all with on-demand billing.
- [ ] TTL attribute `expires_at` is enabled on all tables except `agora_ingest_cursors`.
- [ ] Glue database `agora_parquet` exists.
- [ ] Secret `/agora/manifesto/api_key` exists, and after the manual step `aws secretsmanager get-secret-value ... | jq -r .SecretString | jq .api_key` returns the actual key.
- [ ] Schedule group `agora-schedules` exists and is empty.
- [ ] SNS topic `agora-raw-manifests` exists, no subscriptions.
- [ ] Snapshot tests pass.

## Out of scope

- Lambdas (PR-03 onwards).
- Step Functions (PR-04).
- Populating the buckets with data (PR-03, PR-05, PR-06).
- Populating `agora_ratelimit_counter` — done implicitly by Lambdas at runtime.
- `agora-web` bucket and CloudFront — PR-10.
- Derived tables like `party_cohesion` — PR-07.
