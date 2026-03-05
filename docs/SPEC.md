<!-- 8360e49e-2e0e-49af-834c-e4e1e39b4b9c -->
# Static Hosting with Dynamic Subdomain Routing - Implementation Plan

## Single Source of Truth

- Canonical planning document: `/Users/oleksii.popov/projects/static-hosting-for-vibe-coders/docs/SPEC.md`.
- Deprecated companion document: `/Users/oleksii.popov/.cursor/plans/DNS Wildcard Correction-8360e49e.plan.md` (pointer only, no design content).
- All planning updates must be made in this canonical file only to prevent drift.
- Canonical execution spec: this `docs/SPEC.md` file is the execution source of truth.

## Architecture Summary

```mermaid
flowchart TB
    subgraph Visitors
        V[Visitors]
    end
    
    subgraph CloudFront["CloudFront"]
        CF[Distribution]
        CFn[CloudFront Function]
        L404Resolver["Lambda@Edge 404 Resolver"]
    end
    
    subgraph S3["S3 Origin"]
        E1["/example1/main/"]
        E2["/example2/main/"]
        E2D["/example2/feat-123/"]
    end
    
    V -->|"prod or dev URL"| CF
    CF -->|"viewer-request"| CFn
    CFn -->|"rewrite: tenant + branch"| CF
    CF -->|"origin request"| S3
    S3 -->|"origin-response"| L404Resolver
    L404Resolver -->|"serve closest 404.html or pass-through"| CF
    CF -->|"response"| V
```

**Key decision**: Use CloudFront Functions for subdomain URI rewriting, and use Lambda@Edge (origin-response) only for hierarchical 404 handling of HTML/navigation misses (closest branch/tenant/global 404 page). Non-HTML assets (`js`, `css`, images, fonts, etc.) keep plain origin/default `404` responses. Lambda@Edge remains optional for future basic auth.

**Important**: Do NOT configure CloudFront custom error responses on the distribution — they would conflict with the Lambda@Edge 404 resolver.

---

## URL Structure and S3 Directory Layout

### URL Patterns

| URL Pattern | S3 Path | Use Case |
|-------------|--------|----------|
| `{tenant}.{baseDomain}` | `/{tenant}/{mainBranchName}/` | Production (simple subdomain -> main branch content) |
| `{tenant}--{branch}.dev.{baseDomain}` | `/{tenant}/{branch}/` | Dev (flat subdomain only — single label with `--` separator for wildcard DNS/cert) |

Production uses simple `{tenant}.{baseDomain}` and always resolves to `{mainBranchName}` (default `main`). Dev uses flat subdomains (`{tenant}--{branch}`) so the dev host is a single label, enabling `*.dev.{baseDomain}` wildcard and ACM cert; parsed branch resolves to `/{tenant}/{branch}/`.

**Examples** (base domain `demo.oleksiipopov.com`):

| URL | S3 Path |
|-----|---------|
| `example1.demo.oleksiipopov.com` | `/example1/<main-branch-name>/index.html` |
| `example1.demo.oleksiipopov.com/assets/logo.png` | `/example1/<main-branch-name=main>/assets/logo.png` |
| `example1--feat-new-ui.dev.demo.oleksiipopov.com` | `/example1/feat-new-ui/index.html` |
| `example2--main.dev.demo.oleksiipopov.com/` | `/example2/<main-branch-name=main>/index.html` |

### S3 Directory Structure

```
/
├── {tenant}/
│   ├── 404.html                  # Tenant-level fallback page
│   ├── {mainBranchName}/         # Production content (default: main)
│   │   ├── index.html
│   │   ├── 404.html              # Branch-level fallback page
│   │   ├── assets/
│   │   │   └── ...
│   │   └── ...
│   ├── {branch-a}/               # Branch preview (e.g. feat-new-ui)
│   │   ├── index.html
│   │   ├── 404.html
│   │   └── ...
│   └── {branch-b}/
│       └── ...
└── 404.html                      # Optional global fallback page
```

### Closest 404 Resolution

For missing objects, use closest 404 redirect only for HTML/navigation requests. Non-HTML resource misses should return regular `404` without redirect:

1. Resolve `tenant` and `branch` from subdomain (prod uses `{mainBranchName}`, dev uses parsed `{branch}` from `{tenant}--{branch}`).
2. Detect request type:
   - Treat as HTML/navigation if URI has no file extension, or ends with `.html`, or `Accept` contains `text/html`.
   - Otherwise (e.g. `.js`, `.css`, `.png`, `.svg`, fonts, source maps), return original `404/403` as-is.
3. Build candidate paths in order:
   - `/{tenant}/{branch}/404.html` (branch-level)
   - `/{tenant}/404.html` (tenant-level)
   - `/404.html` (global fallback, optional but recommended)
4. Check candidate existence in S3 (`HeadObject`).
5. Fetch the first existing candidate (`GetObject`) and return its body inline as the Lambda@Edge generated response with **status `404`** and `Content-Type: text/html`. This avoids a redirect (no URL change, no extra round trip, no SEO issues). Lambda@Edge generated response body limit is 1 MB — sufficient for error pages. If no candidate exists, return the original `404/403`.

### Safe Branch and Tenant Names

**Branch name** (used in dev subdomain and S3 path):

- **Character set**: `[a-z0-9-]` (lowercase alphanumeric, hyphens only)
- **Length**: 1–63 characters (DNS label limit)
- **Pattern**: No leading/trailing hyphen; must not contain `--` (reserved as tenant--branch separator)
- **Regex**: `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` and `!name.includes('--')`

**Tenant ID** (used in subdomain and S3 prefix):

- Same rules as branch: `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` and `!id.includes('--')`
- Must be validated at deploy time (CI) and in CloudFront Function (defensive)

**Validation module**: `packages/infra/src/lib/validation.ts` — export `validateBranchName()`, `validateTenantId()`; throw on invalid input.

---

## CloudFront Caching

- **Cache policy**: Custom policy with:
  - HTML: `max-age=0, s-maxage=300, stale-while-revalidate=60` (short TTL for index.html)
  - `404.html`: same short TTL policy as HTML
  - Static assets (`.js`, `.css`, `.png`, etc.): `max-age=31536000, immutable`
- **Error handling split**:
  - HTML/navigation misses: closest-404 redirect flow
  - Non-HTML misses: plain origin/default `404` response (no redirect)
- **Error caching**: Keep HTML-related `403/404` caching TTL very low (`0-10s`) so newly uploaded tenant/branch `404.html` pages are picked up quickly; keep non-HTML miss handling simple (default response behavior is acceptable)
- **Behavior**: Default behavior uses cache policy; consider separate behavior for `/*.html` with shorter TTL
- **Invalidation**: Use path patterns `/{tenant}/{mainBranchName}/*` + `/{tenant}/404.html` (production) or `/{tenant}/{branch}/*` + `/{tenant}/404.html` (specific branch)

---

## Invalidation GitHub Action

**Workflow**: `invalidate-tenant.yml`

- **Trigger**: `workflow_dispatch` with inputs:
  - `tenant` (required): Tenant ID — validated against safe pattern
  - `branch` (optional): Branch name — if provided, invalidate `/{tenant}/{branch}/*` + `/{tenant}/404.html`; if omitted, invalidate `/{tenant}/{mainBranchName}/*` + `/{tenant}/404.html` (production)
  - `wait` (optional, default: false): Whether to poll until invalidation completes
- **Steps**:
  1. Validate `tenant` (and `branch` if provided) with shared validation
  2. Configure AWS credentials (OIDC)
  3. Create invalidation: `aws cloudfront create-invalidation --distribution-id $DIST_ID --paths "/{tenant}/{mainBranchName}/*" "/{tenant}/404.html"` or `--paths "/{tenant}/{branch}/*" "/{tenant}/404.html"`
  4. If `wait`: poll `get-invalidation` until status is `Completed` (with timeout)
- **Distribution ID**: Stored in SSM `/static-hosting/distribution-id` by HostingStack via `StringParameter`
- **Reusability**: Add `workflow_call` so other workflows (e.g. deploy-content) can trigger invalidation after upload

---

## Project Structure

```
static-hosting-for-vibe-coders/
├── .tool-versions              # ASDF: nodejs 24.x, pnpm latest
├── docs/
│   └── SPEC.md                 # Master specification (all aspects)
├── packages/
│   └── infra/
│       ├── src/
│       │   ├── bin/
│       │   │   └── app.ts
│       │   ├── lib/
│       │   │   ├── constructs/
│       │   │   │   ├── static-hosting-bucket.ts
│       │   │   │   ├── subdomain-routing-distribution.ts
│       │   │   │   └── subdomain-routing-function.ts
│       │   │   ├── stacks/
│       │   │   │   └── hosting-stack.ts
│       │   │   └── validation.ts          # validateBranchName, validateTenantId
│       │   ├── scripts/
│       │   │   └── validate-names.ts      # CLI for workflow validation
│       │   └── functions/
│       │       ├── subdomain-routing/
│       │       │   └── index.js           # CloudFront Function (ES5.1)
│       │       └── closest-404/
│       │           └── index.ts           # Lambda@Edge (origin-response)
│       ├── cdk.json
│       ├── package.json
│       └── tsconfig.json
├── .github/
│   └── workflows/
│       ├── deploy-infra.yml
│       ├── validate-infra.yml
│       └── invalidate-tenant.yml          # Manual invalidation for tenant/branch
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

---

## Phase 1: Project Bootstrap and Specification

### 1.1 Create `docs/SPEC.md` (spec-driven development)

Document all aspects:
- **Architecture**: Diagram, components, data flow
- **URL structure**: Production (`{tenant}.{baseDomain}`), dev (`{tenant}--{branch}.dev.{baseDomain}`) — flat subdomains for dev only (wildcard DNS/cert)
- **S3 layout**: `/{tenant}/{mainBranchName}/` (prod), `/{tenant}/{branch}/` (branch preview)
- **404 handling**: For HTML/navigation requests, redirect to closest available 404 page (`/{tenant}/{branch}/404.html` -> `/{tenant}/404.html` -> `/404.html`); for non-HTML resources, return plain `404`
- **Validation**: Branch and tenant name rules (regex, length 1–63)
- **Caching**: CloudFront cache policy (HTML vs static assets)
- **Invalidation**: Manual workflow for tenant/branch, optional wait
- **Tech stack**: Node.js 24, pnpm, TypeScript 5.x, AWS CDK 2.x
- **Environments**: Dev/staging (optional), production
- **Configuration**: Domain, certificate, hosted zone (import or create)
- **Tagging**: `Project`, `Environment`, `ManagedBy` (CDK)
- **Security**: OAC for S3, no public bucket access
- **CI/CD**: GitHub Actions, OIDC, path triggers

### 1.2 Bootstrap project

- Root `package.json` with `engines`: `node: ">=24"`, `pnpm: ">=10"`
- `.tool-versions`: `nodejs 24.11.1`, `pnpm 10.26.1` (or latest)
- `pnpm-workspace.yaml`: `packages: ['packages/*']`
- `packages/infra/`: CDK app, `aws-cdk-lib` latest, `constructs` ^10

**Commit**: `chore: bootstrap project with ASDF, pnpm, and spec`

---

## Phase 2: CDK Constructs

### 2.1 `StaticHostingBucket` construct

- S3 bucket, block public access, Origin Access Control (OAC) for CloudFront
- Use `S3BucketOrigin.withOriginAccessControl()` (not legacy OAI)
- Optional `removalPolicy`, `bucketName` prefix
- Tags: `Project`, `Environment`

### 2.2 `SubdomainRoutingFunction` construct

- CloudFront Function (not Lambda@Edge)
- Logic (ES5.1) — flat subdomain parsing for dev only:
  1. Parse `Host` header (e.g. `example1--feat-123.dev.demo.oleksiipopov.com` or `example1.demo.oleksiipopov.com`):
     - If host contains `.dev.`: extract first label, split on `--` → `tenant = parts[0]`, `branch = parts.slice(1).join("--")` → S3 prefix `/{tenant}/{branch}`
     - Else: single tenant subdomain → S3 prefix `/{tenant}/{mainBranchName}` (default `main`)
  2. Validate tenant/branch with regex `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` and no `--`; if invalid, return 400 or pass through (configurable)
  3. Rewrite `request.uri`: prefix with S3 path; for navigation requests (no file extension), append `/index.html`
  4. FILE_REGEX: `/\\.(html?|css|js|png|jpg|jpeg|gif|ico|svg|woff2?|ttf|eot)(\\?.*)?$/i` or similar
- File: `packages/infra/src/functions/subdomain-routing/index.js`
- Reference: `me/cloud/stacks/front-end/cf-fn-viewer-request.js` pattern

### 2.3 `SubdomainRoutingDistribution` construct

- CloudFront Distribution
- Origin: S3 via OAC (from `StaticHostingBucket`)
- Default behavior: GET/HEAD/OPTIONS, viewer-request CloudFront Function
- **Cache policy**: Custom policy — HTML (`*.html`, `/`) short TTL (e.g. 5 min); static assets long TTL (1 year). Use `CachePolicy` with `minTtl`, `maxTtl`, `defaultTtl`; consider `CachePolicy.fromCachePolicyId` for `CachingOptimized` on static paths, or single policy with `defaultTtl: 300` for HTML-heavy SPAs
- Domain names: `*.demo.oleksiipopov.com`, `*.dev.demo.oleksiipopov.com` (configurable)
- Certificate: ACM (us-east-1), DNS validation, include both wildcards
- **Closest 404 resolver**: Attach Lambda@Edge (origin-response) to handle HTML/navigation `404/403` from S3 and redirect to nearest existing 404 page by host context:
  1. `/{tenant}/{branch}/404.html` (branch-level; prod uses `{mainBranchName}`)
  2. `/{tenant}/404.html` (tenant-level)
  3. `/404.html` (global fallback)
  If none exists, return original `404/403`
- **Implementation note**: Lambda@Edge skips non-HTML assets (returns plain `404/403`). For HTML/navigation: checks candidate existence (`HeadObject`), fetches the first match (`GetObject`), and returns its body inline as a generated response with status `404` and `Content-Type: text/html` (no redirect). Body limit: 1 MB (sufficient for error pages)
- **Tenant/branch resolution**: Lambda@Edge parses tenant and branch from the **rewritten URI** (e.g. `/{tenant}/{branch}/path`), not the Host header, since the CloudFront Function has already rewritten it
- **Lambda@Edge permissions**: The closest-404 resolver's execution role needs `s3:GetObject` and `s3:HeadObject` on the hosting bucket (for candidate existence checks and body fetching). Grant via `bucket.grantRead(closest404Function)`
- **Lambda@Edge region**: Must be deployed in `us-east-1`. Use `cloudfront.experimental.EdgeFunction` (CDK handles cross-region deployment automatically)
- **Output**: Write `distributionId` to SSM parameter `/static-hosting/distribution-id` (StringParameter) for invalidation workflow

### 2.4 `HostingStack` (single stack)

- Composes: `StaticHostingBucket` + `SubdomainRoutingFunction` + `SubdomainRoutingDistribution` (with closest-404 Lambda@Edge association)
- Inputs: `domainName`, `mainBranchName`, `hostedZoneId` (or create), `certificateArn` (optional)
- Outputs: `distributionDomainName`, `distributionUrl`, `bucketName`

**Commit**: `feat(infra): add StaticHostingBucket construct`

**Commit**: `feat(infra): add SubdomainRoutingFunction construct`

**Commit**: `feat(infra): add closest-404 Lambda@Edge resolver`

**Commit**: `feat(infra): add SubdomainRoutingDistribution construct` (associate routing + closest-404 behavior)

**Commit**: `feat(infra): add HostingStack and wire constructs`

---

## Phase 2.5: Validation Module

- `packages/infra/src/lib/validation.ts`:
  - `SAFE_LABEL_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/`
  - `validateBranchName(name: string): void` — throws if invalid (regex + no `--`)
  - `validateTenantId(id: string): void` — throws if invalid (regex + no `--`)
  - `isValidBranchName(name: string): boolean` — for CloudFront Function (or use in CI only; CF runs ES5.1)
- Reusable by: invalidation workflow, deploy scripts, CloudFront Function, and closest-404 Lambda@Edge

**Commit**: `feat(infra): add validation for branch and tenant names`

---

## Phase 3: Route53 and DNS (Wildcard Only)

- If hosted zone exists: `HostedZone.fromLookup` or `fromHostedZoneAttributes`
- Wildcard DNS behavior allows nested matches, but ACM wildcard certificates cover one label only.
- Rationale for dev format: use `{tenant}--{branch}.dev.{baseDomain}` (flat single label) because `{branch}.{tenant}.dev.{baseDomain}` would require per-tenant wildcard certs.
- **Only 2 records** — no per-tenant or per-branch records:
  - `*.demo.oleksiipopov.com` → CNAME or Alias to CloudFront
  - `*.dev.demo.oleksiipopov.com` → CNAME or Alias to CloudFront
- Prefer Route53 Alias (`ARecord`/`AaaaRecord` with `CloudFrontTarget`) when feasible; wildcard `CnameRecord` is also acceptable for subdomains.
- Make DNS optional via stack props (e.g. `hostedZoneId?: string`)

**Commit**: `feat(infra): add wildcard Route53 DNS records for distribution`

---

## Phase 4: Tagging and Naming

- Apply `cdk.Tags.of(stack).add('Project', 'static-hosting')`
- Add `Environment`, `ManagedBy: CDK`
- Use readable construct IDs: `StaticHostingBucket`, `SubdomainRoutingDistribution`, `SubdomainRoutingFunction`

**Commit**: `chore(infra): apply tagging best practices to stack`

---

## Phase 5: GitHub Actions

### 5.1 `validate-infra.yml`

- On: PR to main, push to main
- Paths: `packages/infra/**`, `.github/workflows/validate-infra.yml`
- Steps: checkout, asdf install (from `.tool-versions`), pnpm cache, `pnpm install --frozen-lockfile`, `pnpm type-check`, `pnpm cdk synth` (in packages/infra)
- No AWS credentials needed

### 5.2 `deploy-infra.yml`

- On: push to main, `workflow_dispatch`
- Paths: `packages/infra/**`, `.github/workflows/deploy-infra.yml`
- Permissions: `id-token: write`, `contents: read`
- Steps:
  1. Checkout
  2. `asdf-vm/actions/install@v4` (uses `.tool-versions`)
  3. pnpm cache (same pattern as experiment)
  4. `pnpm install --frozen-lockfile`
  5. `pnpm type-check`
  6. `aws-actions/configure-aws-credentials@v4` with `role-to-assume: ${{ vars.AWS_AUTH_ROLE }}`, `aws-region: us-east-1`
  7. `pnpm cdk deploy --require-approval never` (in packages/infra)

**Commit**: `ci: add validate-infra and deploy-infra workflows`

---

## Phase 5.3: Invalidation Workflow

### `invalidate-tenant.yml`

- **Trigger**: `workflow_dispatch` with inputs:
  - `tenant` (required): Tenant ID
  - `branch` (optional): Branch name — if set, invalidate `/{tenant}/{branch}/*` + `/{tenant}/404.html`; else `/{tenant}/{mainBranchName}/*` + `/{tenant}/404.html`
  - `wait` (optional, default: `false`): Poll until invalidation completes (timeout 5 min)
- **Validation**: Run `pnpm run validate:names --tenant $TENANT [--branch $BRANCH]` (script in packages/infra that uses `validation.ts`) — fail workflow if invalid
- **Steps**:
  1. Checkout
  2. asdf install, pnpm install (or minimal: just Node for aws-cli)
  3. Configure AWS credentials (OIDC)
  4. Get distribution ID from SSM: `aws ssm get-parameter --name /static-hosting/distribution-id`
  5. Compute paths: `/{tenant}/{mainBranchName}/*` + `/{tenant}/404.html` or `/{tenant}/{branch}/*` + `/{tenant}/404.html`
  6. `aws cloudfront create-invalidation --distribution-id $DIST_ID --paths "..."`
  7. If `wait`: loop `aws cloudfront get-invalidation` until `Status=Completed` or timeout

**Commit**: `ci: add invalidate-tenant workflow for CloudFront cache invalidation`

---

## Phase 6: Configuration and Documentation

- `packages/infra/src/config.ts`: central config for `domainName`, `mainBranchName`, `hostedZoneId`, `certificateArn`
- Implementation handoff at execution start: copy this canonical plan into `static-hosting-for-vibe-coders/docs/SPEC.md` as the working spec.
- After handoff, treat `docs/SPEC.md` as the implementation source of truth; update plan files only for archival notes.
- Update `docs/SPEC.md` with final structure, env vars, deployment steps
- `README.md`: quick start, prerequisites, deployment

**Commit**: `docs: add configuration and deployment guide`

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `experiment/.github/workflows/deploy-infra.yml` | OIDC, asdf, pnpm cache, path triggers |
| `experiment/.tool-versions` | nodejs 24.11.1, pnpm 10.26.1 |
| `me/cloud/stacks/front-end/cf-fn-viewer-request.js` | Subdomain routing logic (CloudFront Function) |
| `packages/infra/src/functions/closest-404/index.ts` | Hierarchical 404 redirect resolver (Lambda@Edge) |
| `me/cloud/stacks/front-end/front-end-hosting-stack.ts` | CloudFront + S3 + CF Function pattern |

---

## Construct IDs and Naming

| Resource | Construct ID | Logical Name Pattern |
|---------|--------------|----------------------|
| S3 Bucket | `StaticHostingBucket` | `{project}-static-hosting-{account}` |
| CloudFront Function | `SubdomainRoutingFunction` | `{project}-subdomain-routing` |
| Lambda@Edge 404 Resolver | `Closest404Resolver` | `{project}-closest-404` |
| CloudFront Distribution | `SubdomainRoutingDistribution` | `{project}-hosting` |
| Stack | `HostingStack` | `StaticHostingStack` |

---

## Out of Scope (Future Phases)

- **Basic auth with Lambda@Edge**: Requires Lambda@Edge (origin-request), DynamoDB/SSM for credentials. Defer to Phase 2.
- **Multi-environment**: Single stack for now; add `Environment` prop later.
- **Sample tenant content**: Add `/example1/main/index.html` etc. manually or via separate deploy script.

---

## Commit Strategy (Atomic, Practical)

1. `chore: bootstrap project with ASDF, pnpm, and spec`
2. `feat(infra): add validation for branch and tenant names`
3. `feat(infra): add StaticHostingBucket construct`
4. `feat(infra): add SubdomainRoutingFunction construct` (incl. dev subdomain + branch routing)
5. `feat(infra): add closest-404 Lambda@Edge resolver`
6. `feat(infra): add SubdomainRoutingDistribution construct` (incl. cache policy, closest-404 behavior, SSM output)
7. `feat(infra): add HostingStack and wire constructs`
8. `feat(infra): add wildcard Route53 DNS records for distribution`
9. `chore(infra): apply tagging best practices to stack`
10. `ci: add validate-infra and deploy-infra workflows`
11. `ci: add invalidate-tenant workflow for CloudFront cache invalidation`
12. `docs: add configuration and deployment guide`

---

## Prerequisites (User Action)

- Create GitHub repo variable `AWS_AUTH_ROLE` with IAM role ARN (OIDC)
- Configure OIDC in AWS IAM for the repository (or use existing gha-aws-oidc pattern)
- Have Route53 hosted zone for `demo.oleksiipopov.com` (or adjust domain in config)
