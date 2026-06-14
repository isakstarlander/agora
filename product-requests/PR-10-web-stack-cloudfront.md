# PR-10 — `AgoraWebStack` (S3 + CloudFront + WAF)

## Outcome

`AgoraWebStack` deployed: an `agora-web` S3 bucket, a CloudFront distribution with two origins (the static bucket for `/*` and the API Gateway URL for `/v1/*`), an ACM public certificate (us-east-1, CloudFront-required), an AWS WAF Web ACL with a rate-based rule attached to the distribution, and a `BucketDeployment` custom resource that syncs `web/out/` to the bucket and invalidates `/*`. The dashboard is reachable at `https://<distribution>.cloudfront.net/` (or a custom domain if configured).

## Roadmap anchor

`11-roadmap.md` — Phase 3, steps 5–7 (deploy & WAF); `02-architecture.md` §3.5 and §3.7; `10-iac-bootstrap.md` §3.4.

## Prerequisites

- PR-08 (API deployed; CloudFront needs the API Gateway origin).
- PR-09 (`web/out/` buildable).

## Context

CloudFront is the single front door for the whole site:

- **Default behaviour** → `agora-web` S3 via Origin Access Control (OAC). Static HTML/CSS/JS.
- **`/v1/*` behaviour** → API Gateway HTTP API execute-api origin. Cache TTLs come from the response `Cache-Control` headers (set per route in PR-08).
- **`/openapi/*` behaviour** → `agora-web` S3 with `Cache-Control: public, max-age=86400` and `Content-Type: application/json`.

Why two origins on one distribution: the browser makes all requests same-origin, which avoids CORS preflights, simplifies cookies (we set none), and keeps the WAF rate limit measuring "a user" rather than "an IP per origin". This is the recommended shape in `02-architecture.md` §3.5.

WAF variant: the default is **AWS WAF** with a rate-based rule (300 req / 5 min / IP). Toggling `-c agora:waf=off` replaces it with a CloudFront Function + DynamoDB counter for ~$5/mo saving; see `09-observability-and-security.md` §4.1. This PR implements both and selects based on the context flag.

## Scope / Deliverables

### 1. `agora-web` S3 bucket

`aws_s3.Bucket` in `AgoraWebStack`:

- `blockPublicAccess: BlockPublicAccess.BLOCK_ALL`.
- `encryption: S3_MANAGED`.
- `versioned: false` (static builds are cheap to re-produce).
- `removalPolicy: DESTROY` with `autoDeleteObjects: true` (regenerable).
- `lifecycleRules: [{ enabled: true, expiration: Duration.days(30) }]` on `noncurrentVersions` to keep clutter low.

### 2. Origin Access Control

`cloudfront.S3OriginAccessControl` with `signing: AWS_SIGV4`, `signingBehavior: ALWAYS`. Grant CloudFront `s3:GetObject` on the bucket via a bucket policy referencing the distribution ARN with a `StringEquals` condition.

### 3. CloudFront distribution

`cloudfront.Distribution` with:

- **Default behaviour:**
  - Origin: `S3BucketOrigin.withOriginAccessControl(webBucket, oac)`
  - `viewerProtocolPolicy: REDIRECT_TO_HTTPS`
  - `allowedMethods: ALLOWED_METHODS_GET_HEAD_OPTIONS`
  - `compress: true`
  - `cachePolicy: CachePolicy.CACHING_OPTIMIZED`
  - `responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS` plus a custom policy that adds:
    ```
    Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://data.riksdagen.se https://www.riksdagen.se; connect-src 'self';
    Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
    Referrer-Policy: strict-origin-when-cross-origin
    Permissions-Policy: geolocation=(), microphone=(), camera=()
    X-Content-Type-Options: nosniff
    ```
  - `functionAssociations: [{ function: spaFallbackFn, eventType: VIEWER_REQUEST }]`
    The Spa Fallback function rewrites 404s to `/404.html` (Next.js generates one on export).

- **`/v1/*` behaviour:**
  - Origin: `HttpOrigin(apiGatewayUrlFromCrossStackImport, { protocolPolicy: HTTPS_ONLY })`
  - `viewerProtocolPolicy: HTTPS_ONLY`
  - `allowedMethods: ALLOWED_METHODS_ALL`
  - `cachePolicy: CachePolicy.CACHING_DISABLED`
  - `originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER`
  - `responseHeadersPolicy: ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT_AND_SECURITY_HEADERS`
  - Compression on.

  Cache is off at CloudFront for `/v1/*` because the **response `Cache-Control`** headers from the Lambda already set per-route TTLs. CloudFront will honour them via the `min-TTL=0, default-TTL=0, max-TTL=31536000` setting in `CACHING_DISABLED`? No — that policy also strips upstream Cache-Control. Instead, use a **custom cache policy** `ApiCachePolicy`:

  ```ts
  new cloudfront.CachePolicy(this, "ApiCachePolicy", {
    cachePolicyName: "agora-api",
    defaultTtl: Duration.seconds(0),
    minTtl: Duration.seconds(0),
    maxTtl: Duration.days(1),
    headerBehavior: cloudfront.CacheHeaderBehavior.none(),
    queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
    cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    enableAcceptEncodingGzip: true,
  });
  ```

  which honours the origin's `Cache-Control: max-age=N, s-maxage=N` headers.

- **`/openapi/*` behaviour:**
  - Origin: same S3 bucket.
  - Cache policy: `CACHING_OPTIMIZED`.

- `priceClass: PRICE_CLASS_100` (EU + US edge locations only — sufficient for Swedish users, cheapest).
- `httpVersion: HTTP2_AND_3`.
- `logging: { bucket: logsBucket, prefix: 'cloudfront/' }` — uses the `agora-logs` bucket from PR-02.

Export `distributionDomainName` as `CfnOutput`.

### 4. ACM certificate (if custom domain configured)

Only created when CDK context `-c domain=<fqdn>` is set. ACM public cert must be in `us-east-1` for CloudFront:

```ts
if (ctx.domain) {
  const zone = route53.HostedZone.fromLookup(this, "Zone", { domainName: ctx.domain });
  const cert = new acm.DnsValidatedCertificate(this, "SiteCert", {
    domainName: ctx.domain,
    hostedZone: zone,
    region: "us-east-1",
  });
  // distribution picks up { domainNames: [ctx.domain], certificate: cert }
}
```

When no domain is set, CloudFront serves over its default `*.cloudfront.net` hostname.

### 5. WAF Web ACL

In `us-east-1` (CloudFront ACLs are always there):

```ts
const webAcl = new wafv2.CfnWebACL(this, "AgoraWebAcl", {
  scope: "CLOUDFRONT",
  defaultAction: { allow: {} },
  rules: [
    {
      name: "RateLimitIp",
      priority: 0,
      statement: {
        rateBasedStatement: { limit: 300, aggregateKeyType: "IP" },
      },
      action: { block: { customResponse: { responseCode: 429 } } },
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: "RateLimitIp" },
    },
    {
      name: "AWSManagedRulesCommonRuleSet",
      priority: 1,
      overrideAction: { count: {} }, // count-only until we have signal on false positives
      statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesCommonRuleSet" } },
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: "CommonRules" },
    },
  ],
  visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: "AgoraWebAcl" },
});
```

Associate it with the CloudFront distribution.

### 6. WAF-off variant

When `-c agora:waf=off` is passed, **do not** create the Web ACL. Instead:

- Create a CloudFront Function `rateLimitCf` that, on viewer request, does an **atomic counter increment in DynamoDB** against `agora_ratelimit_counter` (PK = IP, SK = 5-minute bucket). If the counter exceeds 300 within the bucket, return a synthesized 429 response.
- Cost: ~$0.20 / mo at expected traffic vs. $5–6 / mo for WAF.
- Trade-off: the CF-Function path is slightly slower (~5 ms overhead) and is less expressive than WAF rules. Acceptable at MVP.

Both paths use the `ratelimit_counter` table PR-02 created.

### 7. Bucket deployment

`aws_s3_deployment.BucketDeployment`:

```ts
new s3_deployment.BucketDeployment(this, "DeployWeb", {
  sources: [s3_deployment.Source.asset(path.join(__dirname, "../../web/out"))],
  destinationBucket: webBucket,
  distribution: distribution,
  distributionPaths: ["/*"],
  prune: true,
  retainOnDelete: false,
  cacheControl: [
    s3_deployment.CacheControl.fromString("public, max-age=3600, must-revalidate"),
  ],
  contentBasedDeduplication: true,
});
```

The OpenAPI artefact produced by PR-08's synth step is also copied:

```ts
new s3_deployment.BucketDeployment(this, "DeployOpenApi", {
  sources: [s3_deployment.Source.asset(path.join(__dirname, "../cdk.out/openapi"))],
  destinationBucket: webBucket,
  destinationKeyPrefix: "openapi",
  distribution: distribution,
  distributionPaths: ["/openapi/*"],
  prune: false,
  cacheControl: [s3_deployment.CacheControl.fromString("public, max-age=86400")],
});
```

### 8. Environment variable injection at build time

The `web/out/` build needs `NEXT_PUBLIC_API_BASE=https://<distribution-domain>/v1`. But the distribution domain isn't known until after CDK computes it, and `BucketDeployment` bundles assets before synth completes. Two options:

- **Option A (recommended).** Use a known CloudFront domain **if a custom domain is configured** (`-c domain=...`) — the web build reads `NEXT_PUBLIC_API_BASE=https://<ctx.domain>/v1`. If no custom domain, the build uses `NEXT_PUBLIC_API_BASE=/v1` (**relative**) and lets the browser figure out the origin. Relative URLs work because the same CloudFront distribution serves both the site and the API.
- **Option B.** Run `web/` build inside CDK via an `Asset` that invokes `npm run build` with `NEXT_PUBLIC_API_BASE=/v1` as env. Same relative-URL outcome but automated.

Pick Option B — it removes the manual step and guarantees the production build uses relative URLs.

### 9. IAM for CloudFront → WAF → S3

Standard CDK-managed roles. No extra IAM beyond what the constructs produce.

### 10. Outputs

`CfnOutput`: `DistributionDomainName`, `DistributionId`, `WebBucketName`, `WafAclArn` (if on).

### 11. Route 53 alias records (if custom domain)

```ts
if (ctx.domain) {
  new route53.ARecord(this, "Alias", {
    zone,
    recordName: ctx.domain,
    target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
  });
  new route53.AaaaRecord(this, "AliasAAAA", { zone, recordName: ctx.domain, target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)) });
}
```

### 12. CORS re-tightening

Now that we have the CloudFront domain, update PR-08's API Gateway CORS `allowOrigins` to `[<distribution-domain>]` (or `[<ctx.domain>]`) via a cross-stack import. Browser traffic now stays same-origin and CORS is effectively a safety net.

### 13. Tests

- Snapshot test asserting `AWS::CloudFront::Distribution` count is 1 and has 3 behaviours.
- Test that the WAF ACL only provisions when `waf=on`.
- Integration smoke test (post-deploy): `curl https://<distribution>/` returns HTML and `curl https://<distribution>/v1/health` returns the API health payload.

## Manual steps

1. If a custom domain is configured: create the Route 53 hosted zone **before** `cdk deploy` (if you have not already) and ensure the registrar's nameservers point to it. ACM DNS validation will fail if the zone is not resolvable.
2. If using `waf=off`: confirm the CloudFront Function is published (CDK handles this automatically; the console shows it under CloudFront → Functions → `agora-rate-limit`).
3. **Verify the site** in a browser: open the distribution URL, navigate through `/`, `/sv/ledamoter/`, `/sv/ansvar/`. Check that the data pages load real data, not errors.

## Acceptance criteria

- [ ] `cdk deploy AgoraWebStack` exits 0.
- [ ] `curl -I https://<distribution>/` returns 200 with `content-type: text/html` and security headers (CSP, HSTS, X-Content-Type-Options).
- [ ] `curl https://<distribution>/v1/health` returns the same health JSON as PR-08's raw execute-api URL.
- [ ] `curl https://<distribution>/openapi/v1.json` returns valid OpenAPI 3.1.
- [ ] Issuing 400 requests in 60 s to any path from one IP triggers a 429 (from WAF if on, from the CloudFront Function otherwise).
- [ ] The dashboard's browser console shows no CORS errors and no console errors during a visit to `/`, `/sv/ledamoter`, `/sv/budget`, `/sv/ansvar`.
- [ ] `agora-logs/cloudfront/` accumulates access logs.
- [ ] `cdk deploy AgoraWebStack -c domain=<fqdn>` on a second pass wires the custom domain and ACM cert without drift.

## Out of scope

- Observability dashboards and alarms — PR-11.
- Analytics. CloudFront access logs go to `agora-logs`; if we ever want aggregate traffic numbers we run an Athena query per `09-observability-and-security.md` §1. No GA / PostHog.
- Custom 404 / 500 pages beyond Next's default — can be designed later.
- DNS registration (assume the domain is already registered and its zone is in Route 53).
