# PR-15 — CI/CD with GitHub Actions + OIDC

## Outcome

Three GitHub Actions workflows live on `.github/workflows/`: `ci.yml` (lint + typecheck + test on every push), `deploy.yml` (CDK diff on PR, CDK deploy on merge to `main` for all five stacks), and `nightly.yml` (scheduled synth + security scan). GitHub federates into AWS via OIDC with two roles — `agora-github-ci` (read-only) and `agora-github-deploy` (deploy-only) — bootstrapped by a CDK stack `AgoraCicdStack`. No long-lived AWS keys exist in GitHub secrets.

## Roadmap anchor

`10-iac-bootstrap.md` §§5–6; transverse to every phase — but needed before a human other than the maintainer touches the repo.

## Prerequisites

- PR-01 through PR-14 merged on `main` (the deploy pipeline deploys every stack this project has).
- A GitHub repository exists (suggested: `platon/agora`). Claude this PR is authored against `main`-branch protection with at least one reviewer and "Require status checks" on.

## Context

`10-iac-bootstrap.md` §5 specifies the deploy path: `GitHub → OIDC → IAM role → CDK`. We avoid long-lived credentials entirely. `10-iac-bootstrap.md` §6 specifies that CI must run `cdk synth`, `cdk diff` on PRs, and `cdk deploy` on merges.

The five stacks are `AgoraDataStack`, `AgoraApiStack`, `AgoraLlmStack`, `AgoraWebStack`, `AgoraObsStack` — deployable in that dependency order. Plus `AgoraCicdStack` introduced here (self-hosts the OIDC role, deployed manually on first run and rarely again).

Project health invariants this PR holds:

- A reviewer can run `cdk diff` locally and see the same plan the CI job produced.
- A failed deploy rolls back via CloudFormation; CI surfaces the failure and exits non-zero.
- No secret token (AWS or otherwise) is stored in a GitHub Actions environment that lives longer than a single workflow run.

## Scope / Deliverables

### 1. New CDK stack: `AgoraCicdStack`

```
iac/lib/stacks/cicd-stack.ts
```

Provisions:

- **GitHub OIDC provider** (one per account):
  ```ts
  new iam.OpenIdConnectProvider(this, "GitHubOidc", {
    url: "https://token.actions.githubusercontent.com",
    clientIds: ["sts.amazonaws.com"],
  });
  ```
- **`agora-github-ci` role**: assumable from any branch + PR of `<org>/agora`; permissions: `AWSReadOnlyAccess` + `cloudformation:Describe*` + `sts:GetCallerIdentity`. Used by `cdk synth` and `cdk diff` on PRs.
- **`agora-github-deploy` role**: assumable only from `main` branch of `<org>/agora`; permissions: the exact `cdk-*-deploy-role-*` trust (established by `cdk bootstrap`), plus `sts:AssumeRole` into the cross-account CDK execution roles. The trust policy restricts `sub` to `repo:<org>/agora:ref:refs/heads/main`:

  ```json
  {
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<acct>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:<org>/agora:ref:refs/heads/main" }
    }
  }
  ```

- **CloudFormation output** `AgoraGithubCiRoleArn` / `AgoraGithubDeployRoleArn` so the workflow YAMLs can reference them by friendly name via repository variables.

Add `AgoraCicdStack` to `bin/agora.ts`. It has **no dependencies** on other stacks (it stands alone and is deployed manually on first run — see manual steps).

### 2. `.github/workflows/ci.yml`

Runs on every push to a non-`main` branch and every PR targeting `main`.

```yaml
name: ci
on:
  push:
    branches-ignore: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read
  id-token: write
  pull-requests: write

jobs:
  iac-lint:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm', cache-dependency-path: iac/package-lock.json }
      - run: npm ci
        working-directory: iac
      - run: npm run lint
        working-directory: iac
      - run: npm run typecheck
        working-directory: iac
      - run: npm test
        working-directory: iac

  iac-synth:
    runs-on: ubuntu-24.04
    needs: iac-lint
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_CI_ROLE }}
          aws-region: eu-north-1
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm', cache-dependency-path: iac/package-lock.json }
      - run: npm ci
        working-directory: iac
      - run: npx cdk synth -c agora:env=prod --all
        working-directory: iac
      - name: cdk diff
        id: diff
        run: npx cdk diff -c agora:env=prod --all 2>&1 | tee diff.txt
        working-directory: iac
      - uses: actions/github-script@v7
        if: github.event_name == 'pull_request'
        with:
          script: |
            const fs = require('fs');
            const body = '```\n' + fs.readFileSync('iac/diff.txt', 'utf8') + '\n```';
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: body.slice(0, 65000),
            });

  web-build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm', cache-dependency-path: web/package-lock.json }
      - run: npm ci
        working-directory: web
      - run: npm run lint
        working-directory: web
      - run: npm run typecheck
        working-directory: web
      - run: npm run build
        working-directory: web
        env:
          NEXT_PUBLIC_API_BASE: /v1
          NEXT_PUBLIC_SITE_URL: https://ci.local

  py-lint:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: pip install ruff mypy
      - run: ruff check iac/lambda/
      - run: ruff format --check iac/lambda/
      - run: mypy iac/lambda/ --install-types --non-interactive || true
```

### 3. `.github/workflows/deploy.yml`

Runs on merge to `main`. Sequential, one stack at a time.

```yaml
name: deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      stack:
        description: 'Stack to deploy (default: all)'
        required: false
        default: 'all'

permissions:
  contents: read
  id-token: write

concurrency:
  group: deploy-prod
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-24.04
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE }}
          aws-region: eu-north-1
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm', cache-dependency-path: iac/package-lock.json }
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: npm ci
        working-directory: iac

      # Build the web/ static bundle; CDK BucketDeployment will upload it.
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm', cache-dependency-path: web/package-lock.json }
      - run: npm ci && npm run build
        working-directory: web
        env:
          NEXT_PUBLIC_API_BASE: /v1
          NEXT_PUBLIC_SITE_URL: https://${{ vars.AGORA_DOMAIN }}

      # Deploy order matters: data → api → llm → obs → web
      - run: npx cdk deploy AgoraDataStack --require-approval never -c agora:env=prod
        working-directory: iac
        if: ${{ inputs.stack == 'all' || inputs.stack == 'AgoraDataStack' || inputs.stack == '' }}
      - run: npx cdk deploy AgoraApiStack --require-approval never -c agora:env=prod
        working-directory: iac
        if: ${{ inputs.stack == 'all' || inputs.stack == 'AgoraApiStack' || inputs.stack == '' }}
      - run: npx cdk deploy AgoraLlmStack --require-approval never -c agora:env=prod
        working-directory: iac
        if: ${{ inputs.stack == 'all' || inputs.stack == 'AgoraLlmStack' || inputs.stack == '' }}
      - run: npx cdk deploy AgoraObsStack --require-approval never -c agora:env=prod
        working-directory: iac
        if: ${{ inputs.stack == 'all' || inputs.stack == 'AgoraObsStack' || inputs.stack == '' }}
      - run: npx cdk deploy AgoraWebStack --require-approval never -c agora:env=prod
        working-directory: iac
        if: ${{ inputs.stack == 'all' || inputs.stack == 'AgoraWebStack' || inputs.stack == '' }}

  smoke:
    runs-on: ubuntu-24.04
    needs: deploy
    steps:
      - name: GET /v1/health
        run: |
          out=$(curl -fsSL "https://${{ vars.AGORA_DOMAIN }}/v1/health")
          echo "$out" | jq -e '.status == "ok"'
      - name: GET /v1/members top row
        run: |
          curl -fsSL "https://${{ vars.AGORA_DOMAIN }}/v1/members?rm=2024/25" \
            | jq -e '.items | length > 300'
```

Uses GitHub **environment protection** on `production` to gate deploys behind a manual approval if `vars.REQUIRE_APPROVAL=true` (set after first cut, not on day one so the project can ship).

### 4. `.github/workflows/nightly.yml`

Runs at `04:00 UTC` daily. Scheduled CDK synth against `main` to catch drift (environment flag changes that aren't deployed; new AWS CDK version incompatibilities). Also runs `npm audit` and `pip-audit`.

```yaml
name: nightly
on:
  schedule:
    - cron: '0 4 * * *'
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

jobs:
  synth-drift:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with: { ref: main }
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_CI_ROLE }}
          aws-region: eu-north-1
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
        working-directory: iac
      - run: npx cdk diff -c agora:env=prod --all --fail
        working-directory: iac

  npm-audit:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci && npm audit --audit-level=high
        working-directory: iac
      - run: npm ci && npm audit --audit-level=high
        working-directory: web

  py-audit:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: pip install pip-audit
      - run: pip-audit -r iac/lambda/transform/requirements.txt
      - run: pip-audit -r iac/lambda/derive/requirements.txt
      - run: pip-audit -r iac/lambda/api/requirements.txt
      - run: pip-audit -r iac/lambda/llm-read/requirements.txt
      - run: pip-audit -r iac/lambda/llm-acc/requirements.txt
      - run: pip-audit -r iac/lambda/embed-chunks/requirements.txt
      - run: pip-audit -r iac/lambda/weekly-digest/requirements.txt
```

Any non-zero exit sends a failure notification via GitHub's built-in email to repo admins. No SNS wiring needed — CI failures are not ops alarms.

### 5. GitHub repository configuration

Settings the maintainer applies (documented in `iac/README.md`):

- **Repository variables** (Settings → Secrets and variables → Actions → Variables):
  - `AWS_CI_ROLE` = `AgoraGithubCiRoleArn` output value.
  - `AWS_DEPLOY_ROLE` = `AgoraGithubDeployRoleArn` output value.
  - `AGORA_DOMAIN` = `agora.<domain>` or the CloudFront URL if no custom domain.
- **Branch protection on `main`**:
  - Require PR reviews (≥1).
  - Require status checks: `iac-lint`, `iac-synth`, `web-build`, `py-lint` must all pass.
  - Disallow force-push.
  - Disallow direct pushes for anyone (even admins) during normal operation.
- **Environment `production`**:
  - Deployment branches restricted to `main`.
  - Optional required reviewers (the maintainer).
- **Actions → General → Workflow permissions**: set to *"Read repository contents and packages permissions"*. Token write is only granted per-job via `permissions: id-token: write`.

### 6. Pre-commit hook (optional but recommended)

`.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.4.0
    hooks:
      - id: ruff
      - id: ruff-format
  - repo: local
    hooks:
      - id: iac-typecheck
        name: CDK typecheck
        entry: bash -c 'cd iac && npx tsc --noEmit'
        language: system
        pass_filenames: false
```

Mentioned in `iac/README.md`; not enforced in CI to avoid duplication.

### 7. Rollback story

No automated rollback workflow — CloudFormation rolls stacks back automatically on failure. If a successful deploy introduces a bug:

- `git revert <commit>` and push to `main` → re-runs `deploy.yml` on the previous state.
- For a Lambda code bug without wanting to revert infra, the manual unblock is `aws lambda update-function-code --function-name <name> --s3-bucket cdk-hnb659fds-assets-... --s3-key <old-asset>`; document this in `iac/README.md` operator cheat-sheet.

### 8. CI cache hygiene

- Cache `iac/node_modules` keyed on `iac/package-lock.json`.
- Cache `web/node_modules` keyed on `web/package-lock.json`.
- Cache pip wheels on `requirements.txt` hashes.
- Do **not** cache the CDK `cdk.out/` directory (too small to matter; makes staleness debugging harder).

## Manual steps

1. **Bootstrap the CDK environment once.** Before any workflow runs, a human with AWS credentials runs:

   ```bash
   cd iac
   npx cdk bootstrap aws://<acct>/eu-north-1 \
     --profile agora-se \
     --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
   # Also bootstrap us-east-1 for the CloudFront cert (PR-10):
   npx cdk bootstrap aws://<acct>/us-east-1 --profile agora-se
   ```

2. **Deploy `AgoraCicdStack` manually** (it isn't in the deploy workflow because the workflow needs its outputs to exist):

   ```bash
   npx cdk deploy AgoraCicdStack --profile agora-se -c github:org=<org> -c github:repo=agora
   ```

   Capture the two output ARNs.

3. **Set GitHub variables**: `AWS_CI_ROLE`, `AWS_DEPLOY_ROLE`, `AGORA_DOMAIN` in repo Settings.

4. **Configure branch protection** on `main` as described in §5.

5. **Open a no-op PR** (e.g. edit `iac/README.md`) to verify:
   - `ci.yml` runs.
   - `cdk diff` comment appears on the PR.
   - No AWS credentials leak into CI logs (`*** ***` redaction only — no base64 blobs).

6. **Merge the PR** and verify:
   - `deploy.yml` runs.
   - All five stacks show `no changes` (since the PR was a README edit).
   - `smoke` job passes against the live endpoints.

7. **Fail-test the deploy role**. From a throwaway branch, push a workflow that tries to use `AWS_DEPLOY_ROLE`. OIDC should deny because `sub` doesn't match `refs/heads/main`. This verifies the trust policy is tight.

## Acceptance criteria

- [ ] `AgoraCicdStack` deployed; two IAM roles exist with OIDC trust restricted to the repo.
- [ ] `main` branch protection enabled with the four required status checks.
- [ ] A PR to `main` shows CI status, including a `cdk diff` comment on the PR.
- [ ] Merging to `main` deploys all five stacks successfully and the `smoke` job passes.
- [ ] A push to a non-main branch that attempts to assume `AWS_DEPLOY_ROLE` is rejected by STS (AccessDenied).
- [ ] `nightly.yml` runs on schedule and exits non-zero if an npm or pip high-severity advisory appears.
- [ ] No secret of any kind is stored as a GitHub Actions repository secret (only repository *variables* for ARNs).
- [ ] `iac/README.md` has a "CI/CD" section matching §5 exactly.

## Out of scope

- Deploy-preview environments per PR. One environment (prod). If a staging account is ever desired, it's an `-c agora:env=stage` flag + a duplicate `AgoraCicdStack` in that account; out of scope here.
- Automatic rollback on smoke-test failure. Manual revert is the rollback story.
- Progressive deploys / canary routing. AgoraWebStack fronts CloudFront; Lambda aliases with weighted deploys are deferred until there is a reason.
- GitHub PR labels for "skip-deploy". If a change shouldn't deploy, it shouldn't land on `main`.
- Notifying Slack / email on deploy success. GitHub's own notifications are sufficient.
- Signing container images. Lambda container images are private to this account. Add Sigstore/Notation later if ever shared.
