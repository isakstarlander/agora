# PR-01 — CDK monorepo scaffold

## Outcome

A `agora/iac/` TypeScript CDK app that synths and diffs against the account from PR-00 with five empty-but-named stacks (`AgoraDataStack`, `AgoraApiStack`, `AgoraLlmStack`, `AgoraWebStack`, `AgoraObsStack`), a shared constructs folder, context-driven deploy flags, and a one-command `cdk bootstrap` procedure. No functional AWS resources yet — this is the skeleton every subsequent PR plugs into.

## Roadmap anchor

`11-roadmap.md` — Phase 1, step 1.

## Prerequisites

- PR-00 complete. `agora-se` SSO profile working; Bedrock model-access approval may still be in flight (not needed for this PR).
- Local Node.js 20 LTS installed (`.nvmrc` will pin this; use `nvm use` after checkout).
- AWS CLI v2.
- Docker Desktop (or equivalent) running locally — CDK requires it for container-image Lambdas built in later PRs, and `cdk synth` invokes the Docker CLI for asset bundling even when images are not yet defined.

## Context

The top-level repository layout, after all PRs ship, is:

```
agora/                         # this repo
  README.md                    # existing
  00-foundation.md ...         # existing plan docs (unchanged by any PR)
  agora/                       # existing Supabase-based prior implementation (read-only from PR-01 onwards)
  product-requests/            # this folder
  iac/                         # THIS PR creates this
    package.json
    cdk.json
    tsconfig.json
    bin/agora.ts               # CDK app entry point
    lib/
      data-stack.ts
      api-stack.ts
      llm-stack.ts
      web-stack.ts
      obs-stack.ts
      constructs/
        parquet-lambda.ts      # factory for container-image Python Lambdas
        node-lambda.ts         # factory for bundled Node 20 Lambdas
        schedule.ts            # EventBridge scheduler wrapper
        secret.ts              # Secrets Manager wrapper with empty-create pattern
        env.ts                 # shared env/context helpers (region, account, tags)
    test/
      snapshot.test.ts         # CDK synth snapshot test
  web/                         # created in PR-09 (do not create here)
  docs-site-source/            # optional, not created in this PR
```

The `iac/` subtree is a self-contained npm project. It does **not** share a workspace with the existing `agora/` (prior implementation) nor with the future `web/` directory — CDK has its own lifecycle, its own test runner, and mixing it with Next.js causes version-skew pain. A plain `iac/package.json` is the right choice.

All stacks go in a single AWS account and single region. Parallel `dev` stacks are supported via CDK context (`-c env=dev` prefixes all resource names with `dev-`).

## Scope / Deliverables

### 1. `iac/package.json`

```json
{
  "name": "@agora/iac",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "synth": "cdk synth --all",
    "diff":  "cdk diff --all",
    "deploy": "cdk deploy --all",
    "test": "jest",
    "lint": "eslint .",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "@types/jest": "^29",
    "@types/node": "^20",
    "aws-cdk": "^2.160.0",
    "esbuild": "^0.24.0",
    "eslint": "^9",
    "jest": "^29",
    "prettier": "^3",
    "ts-jest": "^29",
    "ts-node": "^10",
    "typescript": "^5.5"
  },
  "dependencies": {
    "aws-cdk-lib": "^2.160.0",
    "constructs": "^10.3.0"
  }
}
```

### 2. `iac/tsconfig.json`

Standard CDK TypeScript config. `target: "ES2022"`, `module: "commonjs"`, `strict: true`, `esModuleInterop: true`, `skipLibCheck: true`, include `bin/**/*` and `lib/**/*`, exclude `cdk.out`, `node_modules`.

### 3. `iac/cdk.json`

```json
{
  "app": "npx ts-node --prefer-ts-exts bin/agora.ts",
  "watch": { "include": ["**"], "exclude": ["README.md", "cdk*.out", "**/*.d.ts", "**/*.js", "tsconfig.json", "package*.json", "yarn.lock", "node_modules"] },
  "context": {
    "@aws-cdk/aws-lambda:recognizeLayerVersion": true,
    "@aws-cdk/core:checkSecretUsage": true,
    "@aws-cdk/core:target-partitions": ["aws"],
    "@aws-cdk-containers/ecs-service-extensions:enableDefaultLogDriver": true,
    "agora:defaultRegion": "eu-north-1",
    "agora:env": "prod",
    "agora:scheduleIntensity": "normal",
    "agora:waf": "on",
    "agora:bedrock": "on",
    "agora:apiTiers": "off",
    "agora:rebuild": false,
    "agora:reembed": false,
    "agora:ratelimit.llmRpm": 2
  }
}
```

The `agora:*` context keys are the **ops flags** documented in `10-iac-bootstrap.md` §7. They are resolved in `bin/agora.ts` and passed into the stacks as typed props. Override on the CLI with `-c agora:env=dev`, `-c agora:waf=off`, etc.

### 4. `iac/bin/agora.ts`

Entry point. Pseudocode:

```ts
import * as cdk from "aws-cdk-lib";
import { readContext } from "../lib/constructs/env";
import { AgoraDataStack } from "../lib/data-stack";
import { AgoraApiStack } from "../lib/api-stack";
import { AgoraLlmStack } from "../lib/llm-stack";
import { AgoraWebStack } from "../lib/web-stack";
import { AgoraObsStack } from "../lib/obs-stack";

const app = new cdk.App();
const ctx = readContext(app); // { env, region, account, waf, bedrock, apiTiers, scheduleIntensity, rebuild, reembed, contactEmail, domain, ratelimit }

const prefix = ctx.env === "prod" ? "" : `${ctx.env}-`;
const props  = { env: { account: ctx.account, region: ctx.region }, prefix, ctx, tags: { Project: "agora", Env: ctx.env, ManagedBy: "cdk" } };

const data = new AgoraDataStack(app, `${prefix}AgoraDataStack`, props);
const api  = new AgoraApiStack (app, `${prefix}AgoraApiStack`, { ...props, data });
const llm  = new AgoraLlmStack (app, `${prefix}AgoraLlmStack`, { ...props, data, api });
const web  = new AgoraWebStack (app, `${prefix}AgoraWebStack`, { ...props, api });
const obs  = new AgoraObsStack (app, `${prefix}AgoraObsStack`, { ...props, data, api, llm, web });

cdk.Tags.of(app).add("Project", "agora");
cdk.Tags.of(app).add("Env", ctx.env);
```

Each stack class in this PR is an **empty** `cdk.Stack` subclass that accepts the typed props and does nothing else. Subsequent PRs add resources inside them.

### 5. `iac/lib/constructs/env.ts`

Exports `readContext(app: cdk.App)` that:

- Reads `agora:env`, `agora:waf`, `agora:bedrock`, `agora:apiTiers`, `agora:scheduleIntensity`, `agora:rebuild`, `agora:reembed`, `agora:ratelimit.llmRpm` from CDK context with sane defaults matching `cdk.json`.
- Reads `contactEmail` and optional `domain` from context; throws if `contactEmail` is missing on `env=prod`.
- Reads `bedrockModels` (array of Bedrock foundation-model ARNs) from context; defaults to the two models listed in `10-iac-bootstrap.md` §4 within `eu-north-1`.
- Resolves `account` from `process.env.CDK_DEFAULT_ACCOUNT` and `region` from the `agora:defaultRegion` context key (falling back to `CDK_DEFAULT_REGION`).
- Returns a **fully-typed** config object that the stacks consume.

### 6. `iac/lib/constructs/node-lambda.ts`

A thin factory that wraps `aws_lambda_nodejs.NodejsFunction` with:

- `architecture: Architecture.ARM_64`.
- `runtime: Runtime.NODEJS_20_X`.
- Default `timeout: Duration.seconds(30)`.
- `memorySize: 512` by default; overridable.
- `bundling: { minify: true, sourceMap: true, target: "node20" }`.
- `tracing: Tracing.DISABLED` (X-Ray off by default; re-enabled per Lambda if debugging).
- `logRetention: RetentionDays.ONE_MONTH` (30 days per `09-observability-and-security.md` §1.1).
- Default `environment: { POWERTOOLS_SERVICE_NAME: <name>, LOG_LEVEL: "INFO" }`.

### 7. `iac/lib/constructs/parquet-lambda.ts`

Factory for **container-image Python Lambdas** (used by `transform`, `derive`, `api`, `llm-read`, `llm-acc`, `embed-chunks` from PR-06 onwards). Wraps `DockerImageFunction` with:

- `architecture: Architecture.ARM_64`.
- `memorySize: 1024` default, overridable.
- `timeout: Duration.minutes(5)` default.
- `tracing: Tracing.DISABLED`.
- `logRetention: RetentionDays.ONE_MONTH`.
- Builds the image with `DockerImageCode.fromImageAsset(path, { platform: Platform.LINUX_ARM64 })`.

### 8. `iac/lib/constructs/schedule.ts`

Wrapper that creates an EventBridge Scheduler `CfnSchedule` (L1) with:

- `ScheduleExpression: "cron(…)"` (input).
- `FlexibleTimeWindow: { Mode: "OFF" }`.
- `Target: { Arn: <lambda-arn>, RoleArn: <invocation-role-arn>, Input: "{}" }`.

One invocation role per schedule is fine; the role only needs `lambda:InvokeFunction` on the specific target ARN. The `agora:scheduleIntensity` context key (`low` | `normal` | `high`) maps to frequency multipliers consumed in each per-schedule call site later — this PR only exposes the helper.

### 9. `iac/lib/constructs/secret.ts`

Thin wrapper that creates `SecretsManager.Secret` with `secretName` and **no generated secret string** — i.e. the secret exists but its value is empty (`{}`), to be populated manually post-deploy. This pattern recurs for the Manifesto Project API key, the Stripe secrets (Phase 9), etc.

### 10. Five empty stacks

Each of `lib/data-stack.ts`, `lib/api-stack.ts`, `lib/llm-stack.ts`, `lib/web-stack.ts`, `lib/obs-stack.ts` exports a class extending `cdk.Stack`. Constructor takes the typed props from step 4 and currently does nothing except calling `super()`. Later PRs add resources.

Add one marker construct in each stack:

```ts
new cdk.CfnOutput(this, "StackIdMarker", { value: this.stackName, description: "Agora stack marker" });
```

This gives us a non-empty CloudFormation template so `cdk synth` and `cdk deploy` have something to actually do from the first deploy.

### 11. Jest snapshot test

`iac/test/snapshot.test.ts` does:

```ts
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AgoraDataStack } from "../lib/data-stack";

test("DataStack synthesises without error", () => {
  const app = new cdk.App({ context: { "agora:env": "prod", contactEmail: "test@example.com" } });
  const stack = new AgoraDataStack(app, "AgoraDataStack", {
    env: { account: "111111111111", region: "eu-north-1" },
    prefix: "",
    ctx: { /* minimal valid ctx */ },
    tags: {}
  });
  const tmpl = Template.fromStack(stack);
  expect(tmpl.toJSON()).toMatchSnapshot();
});
```

Plus one test per other stack. Snapshots are checked in. The test's only job at this PR is to prevent an accidental empty-synth regression.

### 12. `iac/.gitignore`

Standard: `node_modules/`, `cdk.out/`, `*.d.ts`, `*.js` (compiled TS leftovers), `.env*.local`.

### 13. `iac/README.md`

A short operator cheat-sheet:

```markdown
# Agora IaC

## Usage
\`\`\`
cd iac
npm ci
npx cdk bootstrap aws://<account-id>/eu-north-1 --profile agora-se
npx cdk diff --all -c contactEmail=you@example.com --profile agora-se
npx cdk deploy --all -c contactEmail=you@example.com --profile agora-se
\`\`\`

## Ops flags (see also 10-iac-bootstrap.md §7)
- \`-c agora:env=dev\` — deploy parallel dev stacks with a "dev-" prefix.
- \`-c agora:waf=off\` — use CloudFront-Function rate limiter instead of WAF.
- \`-c agora:bedrock=off\` — omit LLM Lambdas; /v1/summarise, /v1/search, /v1/accountability return 501.
- \`-c agora:scheduleIntensity=low|normal|high\` — adjust ingestion cadence.
- \`-c agora:rebuild=true\` — trigger the one-off manifest-rescan state machine.
- \`-c agora:reembed=true\` — force re-computation of every document_embeddings row.
- \`-c agora:apiTiers=on\` — enable the Phase-9 commercial API tier.
```

### 14. CDK bootstrap (run once, manually)

```bash
cd iac
npm ci
npx cdk bootstrap aws://<account-id>/eu-north-1 \
  --profile agora-se \
  --trust <account-id> \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess \
  --tags Project=agora --tags ManagedBy=cdk
```

Creates the CDK asset bucket (`cdk-hnb659fds-assets-<account>-eu-north-1`), roles, and parameter store entries. Costs fractions of a cent per month.

## Manual steps

1. Run `cdk bootstrap` once per AWS account + region (step 14 above).
2. Run `npx cdk deploy --all -c contactEmail=you@example.com --profile agora-se` and verify five stacks are created in CloudFormation with a single `StackIdMarker` output each.
3. Confirm `cdk destroy --all --profile agora-se` is clean (no retained resources) — this verifies the scaffold has no accidental `removalPolicy: RETAIN` on unimportant resources. After confirmation, redeploy so subsequent PRs have something to build on.

## Acceptance criteria

- [x] `npm ci` completes with no vulnerabilities at severity `high` or above.
- [x] `npx cdk synth --all --profile agora-se` exits 0 and emits a `cdk.out/` containing 5 CloudFormation templates.
- [x] `npx cdk deploy --all --profile agora-se` creates 5 CloudFormation stacks (`AgoraDataStack`, `AgoraApiStack`, `AgoraLlmStack`, `AgoraWebStack`, `AgoraObsStack`), each with status `CREATE_COMPLETE`.
- [x] `npm test` passes (5 snapshot tests, one per stack).
- [x] Resource tags on the five stacks include `Project=agora`, `Env=prod`, `ManagedBy=cdk`.
- [ ] Running with `-c agora:env=dev` creates five **additional** stacks with the `dev-` prefix, without affecting prod ones.
- [x] `iac/README.md` exists and is accurate.

## Out of scope

- Any actual AWS resources beyond the CDK bootstrap bucket and the empty-stack marker outputs. S3 buckets, DynamoDB tables, Lambdas, etc. all arrive in PR-02 and later.
- CI/CD configuration (`.github/workflows/*`) — that is PR-15.
- The `web/` directory — PR-09.
- Modifications to the existing `agora/` (prior implementation) directory. Leave it strictly alone; this PR treats it as read-only reference material.
