<!-- 8360e49e-2e0e-49af-834c-e4e1e39b4b9c -->
# Static Hosting with Dynamic Subdomain Routing - Implementation Plan

## Single Source of Truth

- Canonical planning document: `docs/SPEC.md` (this file).
- All planning updates must be made in this canonical file only to prevent drift.

## Purpose

A single-company platform for hosting multiple static apps with automatic branch previews. Each app lives in its own GitHub repository and deploys to a shared infrastructure (one S3 bucket, one CloudFront distribution). App repos integrate via a reusable GitHub Actions workflow that handles build, deploy, cache invalidation, and PR preview URL comments.

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
    CFn -->|"rewrite: app + branch"| CF
    CF -->|"origin request"| S3
    S3 -->|"origin-response"| L404Resolver
    L404Resolver -->|"serve closest 404.html or pass-through"| CF
    CF -->|"response"| V
```

**Key decision**: Use CloudFront Functions for subdomain URI rewriting, and use Lambda@Edge (origin-response) only for hierarchical 404 handling of HTML/navigation misses (closest branch/app/global 404 page). Non-HTML assets (`js`, `css`, images, fonts, etc.) keep plain origin/default `404` responses. Lambda@Edge remains optional for future basic auth.

**Important**: Do NOT configure CloudFront custom error responses on the distribution — they would conflict with the Lambda@Edge 404 resolver.

### Scalability

- S3 has no practical prefix limit — hundreds or thousands of apps work fine
- CloudFront: 1,000 free invalidation paths/month, then $0.005/path — budget consideration for frequent deploys across many apps
- Single distribution handles all apps (CloudFront has no origin-path-count limit)

---

## URL Structure and S3 Directory Layout

### URL Patterns

| URL Pattern | S3 Path | Use Case |
|-------------|--------|----------|
| `{app}.{baseDomain}` | `/{app}/{mainBranchName}/` | Production (simple subdomain -> main branch content) |
| `{app}--{branch}.dev.{baseDomain}` | `/{app}/{branch}/` | Dev (flat subdomain only — single label with `--` separator for wildcard DNS/cert) |

Production uses simple `{app}.{baseDomain}` and always resolves to `{mainBranchName}` (default `main`). Dev uses flat subdomains (`{app}--{branch}`) so the dev host is a single label, enabling `*.dev.{baseDomain}` wildcard and ACM cert; parsed branch resolves to `/{app}/{branch}/`.

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
├── {app}/
│   ├── 404.html                  # App-level fallback page
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

For missing objects, serve the closest 404 page inline for HTML/navigation requests only. Non-HTML resource misses return a regular `404` without intervention:

1. Resolve `app` and `branch` from subdomain (prod uses `{mainBranchName}`, dev uses parsed `{branch}` from `{app}--{branch}`).
2. Detect request type:
   - Treat as HTML/navigation if URI has no file extension, or ends with `.html`, or `Accept` contains `text/html`.
   - Otherwise (e.g. `.js`, `.css`, `.png`, `.svg`, fonts, source maps), return original `404/403` as-is.
3. Build candidate paths in order:
   - `/{app}/{branch}/404.html` (branch-level)
   - `/{app}/404.html` (app-level)
   - `/404.html` (global fallback, optional but recommended)
4. Check candidate existence in S3 (`HeadObject`).
5. Fetch the first existing candidate (`GetObject`) and return its body inline as the Lambda@Edge generated response with **status `404`** and `Content-Type: text/html`. This avoids a redirect (no URL change, no extra round trip, no SEO issues). Lambda@Edge generated response body limit is 1 MB — sufficient for error pages. If no candidate exists, return the original `404/403`.

**SPA fallback**: For single-page apps with client-side routing, apps should use their branch-level `404.html` as the SPA entry point (same content as `index.html`). The closest-404 resolver will serve it for any unmatched HTML path, preserving the original URL.

### Client-Side Routing Modes

The platform supports all common routing strategies without per-app configuration:

- **Static / MPA** — works naturally; each page is a real file in S3
- **Hash routing** (`/#/path`) — works out of the box; the hash fragment is never sent to the server, so S3 always serves `index.html`
- **History / browser routing (SPA)** — deploy `404.html` with the same content as `index.html`; the closest-404 resolver serves it inline for any unmatched path, preserving the URL for the client-side router to handle

### Safe Branch and App Names

**Branch name** (used in dev subdomain and S3 path):

- **Character set**: `[a-z0-9-]` (lowercase alphanumeric, hyphens only)
- **Length**: 1–63 characters (DNS label limit)
- **Pattern**: No leading/trailing hyphen; must not contain `--` (reserved as app--branch separator)
- **Regex**: `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` and `!name.includes('--')`
- **Sanitization**: Git branch names are sanitized before use — lowercase, replace any run of unsupported characters (`/`, `_`, `.`, etc.) with a single `-`, strip leading/trailing `-`, truncate to 63 chars. Examples: `feature/login` → `feature-login`, `Feature/New__UI` → `feature-new-ui`, `fix/bug...#123` → `fix-bug-123`. The deploy workflow applies this automatically; the validation regex runs after sanitization

**App slug** (used in subdomain and S3 prefix):

- Same rules as branch: `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` and `!slug.includes('--')`
- Must be validated at deploy time (CI) and in CloudFront Function (defensive)

**Validation module**: `packages/infra/src/lib/validation.ts` — export `validateBranchName()`, `validateAppSlug()`; throw on invalid input.

---

## CloudFront Caching

- **CloudFront cache policy** (controls edge TTL via `CachePolicy`):
  - HTML / `404.html`: `defaultTtl: 300s`, `minTtl: 0`, `maxTtl: 300s` (short edge TTL)
  - Static assets (`.js`, `.css`, `.png`, etc.): use managed `CachingOptimized` policy (default TTL 24h, max 1yr) or a custom policy with `defaultTtl: 86400s`, `maxTtl: 31536000s`
  - Consider a separate cache behavior for `/*.html` with the short-TTL policy
- **Origin response headers** (controls browser caching — set by app's files or overridden via a CloudFront response headers policy):
  - HTML: `Cache-Control: max-age=0, s-maxage=300, stale-while-revalidate=60`
  - Static assets: `Cache-Control: max-age=31536000, immutable`
- **Error handling split**:
  - HTML/navigation misses: closest-404 inline body served by Lambda@Edge
  - Non-HTML misses: plain origin `404` response (no Lambda@Edge intervention)
- **Error caching**: Keep `403/404` error caching TTL very low (`0–10s`) so newly uploaded `404.html` pages are picked up quickly
- **Invalidation**: Use path patterns `/{app}/{mainBranchName}/*` + `/{app}/404.html` (production) or `/{app}/{branch}/*` + `/{app}/404.html` (specific branch). To invalidate the global fallback, use `/404.html` separately

---

## Invalidation GitHub Action

**Workflow**: `invalidate-app.yml`

- **Trigger**: `workflow_dispatch` with inputs:
  - `app` (required): App slug — validated against safe pattern
  - `branch` (optional): Branch name — if provided, invalidate `/{app}/{branch}/*` + `/{app}/404.html`; if omitted, invalidate `/{app}/{mainBranchName}/*` + `/{app}/404.html` (production)
  - `wait` (optional, default: false): Whether to poll until invalidation completes
- **Steps**:
  1. Validate `app` (and `branch` if provided) with shared validation
  2. Configure AWS credentials (OIDC)
  3. Create invalidation: `aws cloudfront create-invalidation --distribution-id $DIST_ID --paths "/{app}/{mainBranchName}/*" "/{app}/404.html"` or `--paths "/{app}/{branch}/*" "/{app}/404.html"`
  4. If `wait`: poll `get-invalidation` until status is `Completed` (with timeout)
- **Distribution ID**: Stored in SSM `/static-hosting/distribution-id` by HostingStack via `StringParameter`
- **Reusability**: Add `workflow_call` so other workflows (e.g. `deploy-app.yml`) can trigger invalidation after upload

---

## Reusable Deploy Workflow

**Workflow**: `deploy-app.yml` — a reusable workflow (`workflow_call`) that app repositories consume to build, deploy, invalidate, and post preview URLs.

### Usage from app repo

```yaml
# In app repo: .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]
  pull_request:

jobs:
  deploy:
    uses: <org>/static-hosting-for-vibe-coders/.github/workflows/deploy-app.yml@main
    with:
      app-slug: my-app
      build-command: pnpm build
      output-dir: dist
    secrets: inherit
```

### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `app-slug` | yes | — | App slug (validated against safe pattern) |
| `build-command` | no | `pnpm build` | Command to build the app |
| `output-dir` | no | `dist` | Directory containing build output |
| `branch` | no | `github.ref_name` | Branch name for S3 prefix (auto-derived from PR head or push ref) |

### Requirements

App repos must use **pnpm** as their package manager (platform convention for simplicity).

### Steps

1. Checkout the calling app repo
2. Setup Node.js (asdf or `actions/setup-node`)
3. Install dependencies (`pnpm install --frozen-lockfile`)
4. Run build command
5. Sanitize `branch` and validate `app-slug` and sanitized branch with `validation.ts`
6. Configure AWS credentials (OIDC)
7. `aws s3 sync --delete {output-dir}/ s3://{bucket}/{app-slug}/{branch}/`
8. Trigger CloudFront invalidation (call `invalidate-app.yml` or inline)
9. If PR: post comment with preview URL (`{app-slug}--{branch}.dev.{baseDomain}`)

### PR Preview Comment

On pull request events, the workflow posts (or updates) a comment with the preview URL:

```
Preview: https://{app-slug}--{branch}.dev.demo.oleksiipopov.com
```

Uses `peter-evans/create-or-update-comment` or similar action. The comment is updated on subsequent pushes to the same PR.

### Secrets and Permissions

- `id-token: write` — for OIDC AWS authentication
- `contents: read` — to checkout the app repo
- `pull-requests: write` — to post preview URL comments
- Bucket name: read from SSM `/static-hosting/bucket-name` or passed as input
- Distribution ID: read from SSM `/static-hosting/distribution-id`

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
│       │   │   └── validation.ts          # validateBranchName, validateAppSlug
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
│       ├── deploy-app.yml                 # Reusable workflow for app repos
│       ├── cleanup-branch.yml             # Reusable workflow for branch removal
│       ├── cleanup-app.yml                # Manual workflow for full app removal
│       └── invalidate-app.yml             # Manual invalidation for app/branch
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

---

## Phase 1: Project Bootstrap and Specification

### 1.1 Create `docs/SPEC.md` (spec-driven development)

Document all aspects:
- **Architecture**: Diagram, components, data flow
- **URL structure**: Production (`{app}.{baseDomain}`), dev (`{app}--{branch}.dev.{baseDomain}`) — flat subdomains for dev only (wildcard DNS/cert)
- **S3 layout**: `/{app}/{mainBranchName}/` (prod), `/{app}/{branch}/` (branch preview)
- **404 handling**: For HTML/navigation requests, serve closest available 404 page inline (`/{app}/{branch}/404.html` -> `/{app}/404.html` -> `/404.html`); for non-HTML resources, return plain `404`
- **Validation**: Branch and app slug rules (regex, length 1–63)
- **Caching**: CloudFront cache policy (HTML vs static assets)
- **Invalidation**: Manual workflow for app/branch, optional wait
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
- **Output**: Write `bucketName` to SSM parameter `/static-hosting/bucket-name` (for deploy workflow)

### 2.2 `SubdomainRoutingFunction` construct

- CloudFront Function (not Lambda@Edge)
- Logic (ES5.1) — flat subdomain parsing for dev only:
  1. Parse `Host` header (e.g. `example1--feat-123.dev.demo.oleksiipopov.com` or `example1.demo.oleksiipopov.com`):
     - If host contains `.dev.`: extract first label, split on `--` → `app = parts[0]`, `branch = parts.slice(1).join("--")` → S3 prefix `/{app}/{branch}`
     - Else: single app subdomain → S3 prefix `/{app}/{mainBranchName}` (default `main`)
  2. Validate app/branch with regex `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` and no `--`; if invalid, return 400 or pass through (configurable)
  3. Rewrite `request.uri`: prefix with S3 path; for navigation requests (no file extension), append `/index.html`
  4. FILE_REGEX: `/\\.(html?|css|js|png|jpg|jpeg|gif|ico|svg|woff2?|ttf|eot)(\\?.*)?$/i` or similar
- File: `packages/infra/src/functions/subdomain-routing/index.js`

### 2.3 `SubdomainRoutingDistribution` construct

- CloudFront Distribution
- Origin: S3 via OAC (from `StaticHostingBucket`)
- Default behavior: GET/HEAD/OPTIONS, viewer-request CloudFront Function
- **Cache policy**: Custom policy — HTML (`*.html`, `/`) short TTL (e.g. 5 min); static assets long TTL (1 year). Use `CachePolicy` with `minTtl`, `maxTtl`, `defaultTtl`; consider `CachePolicy.fromCachePolicyId` for `CachingOptimized` on static paths, or single policy with `defaultTtl: 300` for HTML-heavy SPAs
- Domain names: `*.demo.oleksiipopov.com`, `*.dev.demo.oleksiipopov.com` (configurable)
- Certificate: ACM (us-east-1), DNS validation, include both wildcards
- **Closest 404 resolver**: Attach Lambda@Edge (origin-response) to handle HTML/navigation `404/403` from S3 and serve the nearest existing 404 page inline:
  1. `/{app}/{branch}/404.html` (branch-level; prod uses `{mainBranchName}`)
  2. `/{app}/404.html` (app-level)
  3. `/404.html` (global fallback)
  If none exists, return original `404/403`
- **Implementation note**: Lambda@Edge skips non-HTML assets (returns plain `404/403`). For HTML/navigation: checks candidate existence (`HeadObject`), fetches the first match (`GetObject`), and returns its body inline as a generated response with status `404` and `Content-Type: text/html` (no redirect). Body limit: 1 MB (sufficient for error pages)
- **App/branch resolution**: Lambda@Edge parses app and branch from the **rewritten URI** (e.g. `/{app}/{branch}/path`), not the Host header, since the CloudFront Function has already rewritten it
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
  - `sanitizeBranchName(name: string): string` — lowercase, replace runs of unsupported chars with `-`, strip leading/trailing `-`, truncate to 63 chars
  - `validateBranchName(name: string): void` — throws if invalid (regex + no `--`); runs after sanitization
  - `validateAppSlug(slug: string): void` — throws if invalid (regex + no `--`)
  - `isValidBranchName(name: string): boolean` — for CloudFront Function (or use in CI only; CF runs ES5.1)
- Reusable by: invalidation workflow, deploy scripts, deploy-app workflow, and closest-404 Lambda@Edge (TypeScript contexts)
- **CloudFront Function caveat**: CF Functions run ES5.1 with no module imports — the validation regex must be **duplicated** inline in `subdomain-routing/index.js`. Add a shared test that verifies both copies accept/reject the same inputs to prevent drift

**Commit**: `feat(infra): add validation for branch and app names`

---

## Phase 3: Route53 and DNS (Wildcard Only)

- If hosted zone exists: `HostedZone.fromLookup` or `fromHostedZoneAttributes`
- Wildcard DNS behavior allows nested matches, but ACM wildcard certificates cover one label only.
- Rationale for dev format: use `{app}--{branch}.dev.{baseDomain}` (flat single label) because `{branch}.{app}.dev.{baseDomain}` would require per-app wildcard certs.
- **Only 2 records** — no per-app or per-branch records:
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
  3. pnpm store cache
  4. `pnpm install --frozen-lockfile`
  5. `pnpm type-check`
  6. `aws-actions/configure-aws-credentials@v4` with `role-to-assume: ${{ vars.AWS_AUTH_ROLE }}`, `aws-region: us-east-1`
  7. `pnpm cdk deploy --require-approval never` (in packages/infra)

**Commit**: `ci: add validate-infra and deploy-infra workflows`

---

## Phase 5.3: Invalidation Workflow

### `invalidate-app.yml`

- **Trigger**: `workflow_dispatch` with inputs:
  - `app` (required): App slug
  - `branch` (optional): Branch name — if set, invalidate `/{app}/{branch}/*` + `/{app}/404.html`; else `/{app}/{mainBranchName}/*` + `/{app}/404.html`
  - `wait` (optional, default: `false`): Poll until invalidation completes (timeout 5 min)
- **Validation**: Run `pnpm run validate:names --app $APP [--branch $BRANCH]` (script in packages/infra that uses `validation.ts`) — fail workflow if invalid
- **Steps**:
  1. Checkout
  2. asdf install, pnpm install (or minimal: just Node for aws-cli)
  3. Configure AWS credentials (OIDC)
  4. Get distribution ID from SSM: `aws ssm get-parameter --name /static-hosting/distribution-id`
  5. Compute paths: `/{app}/{mainBranchName}/*` + `/{app}/404.html` or `/{app}/{branch}/*` + `/{app}/404.html`
  6. `aws cloudfront create-invalidation --distribution-id $DIST_ID --paths "..."`
  7. If `wait`: loop `aws cloudfront get-invalidation` until `Status=Completed` or timeout

**Commit**: `ci: add invalidate-app workflow for CloudFront cache invalidation`

---

## Phase 5.5: Reusable Deploy Workflow

### `deploy-app.yml`

- **Trigger**: `workflow_call` (reusable workflow consumed by app repos)
- **Inputs**: `app-slug`, `build-command` (default `pnpm build`), `output-dir` (default `dist`), `branch` (default: derived from trigger ref)
- **Permissions**: `id-token: write`, `contents: read`, `pull-requests: write`
- **Steps**:
  1. Checkout calling repo
  2. Setup Node.js (asdf or `actions/setup-node`)
  3. `pnpm install --frozen-lockfile`
  4. Run `build-command`
  5. Sanitize `branch` and validate `app-slug` and sanitized branch (inline or via `validate-names.ts`)
  6. Configure AWS credentials (OIDC)
  7. Get bucket name from SSM: `aws ssm get-parameter --name /static-hosting/bucket-name`
  8. `aws s3 sync --delete {output-dir}/ s3://{bucket}/{app-slug}/{branch}/`
  9. Trigger invalidation (call `invalidate-app.yml` via `workflow_call` or inline)
  10. If PR event: post/update comment with preview URL `https://{app-slug}--{branch}.dev.{baseDomain}`

**Commit**: `ci: add reusable deploy-app workflow for app repos`

---

## Phase 5.7: Cleanup Workflows

### `cleanup-branch.yml`

Reusable workflow (`workflow_call`) that app repos trigger when a branch is merged or deleted. Removes the branch's S3 directory and invalidates the cache.

- **Trigger**: `workflow_call` with inputs: `app-slug` (required), `branch` (required)
- **Usage from app repo**:
  ```yaml
  on:
    delete:
    pull_request:
      types: [closed]

  jobs:
    cleanup:
      if: github.event.ref_type == 'branch' || github.event.pull_request.merged
      uses: <org>/static-hosting-for-vibe-coders/.github/workflows/cleanup-branch.yml@main
      with:
        app-slug: my-app
        branch: ${{ github.event.ref || github.head_ref }}
      secrets: inherit
  ```
- **Steps**:
  1. Sanitize `branch` and validate `app-slug` and sanitized branch
  2. Configure AWS credentials (OIDC)
  3. Get bucket name from SSM
  4. `aws s3 rm --recursive s3://{bucket}/{app-slug}/{branch}/`
  5. Invalidate `/{app-slug}/{branch}/*`

**Commit**: `ci: add cleanup-branch workflow for stale branch removal`

### `cleanup-app.yml`

Manual workflow (`workflow_dispatch`) to remove all files for an app when its repo is deleted or archived.

- **Trigger**: `workflow_dispatch` with input: `app-slug` (required)
- **Steps**:
  1. Validate `app-slug`
  2. Configure AWS credentials (OIDC)
  3. Get bucket name from SSM
  4. `aws s3 rm --recursive s3://{bucket}/{app-slug}/`
  5. Invalidate `/{app-slug}/*`
- **Safety**: Requires manual trigger — no automation to prevent accidental deletion of an entire app

**Commit**: `ci: add cleanup-app workflow for app removal`

---

## Phase 6: Configuration and Documentation

- `packages/infra/src/config.ts`: central config for `domainName`, `mainBranchName`, `hostedZoneId`, `certificateArn`
- Update `docs/SPEC.md` with final structure, env vars, deployment steps
- `README.md`: quick start, prerequisites, deployment

**Commit**: `docs: add configuration and deployment guide`

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `packages/infra/src/lib/validation.ts` | Branch/app name validation (shared by CDK, scripts, Lambda@Edge) |
| `packages/infra/src/functions/subdomain-routing/index.js` | CloudFront Function — subdomain URI rewriting (ES5.1) |
| `packages/infra/src/functions/closest-404/index.ts` | Lambda@Edge — hierarchical 404 resolver (origin-response) |
| `packages/infra/src/lib/stacks/hosting-stack.ts` | Main CDK stack composing all constructs |
| `.github/workflows/deploy-infra.yml` | CI/CD — OIDC, asdf, pnpm cache, CDK deploy |
| `.github/workflows/deploy-app.yml` | Reusable workflow — build, deploy, invalidate, PR preview comment |
| `.github/workflows/cleanup-branch.yml` | Reusable workflow — remove branch files from S3 on merge/delete |
| `.github/workflows/cleanup-app.yml` | Manual workflow — remove all app files from S3 |
| `.github/workflows/invalidate-app.yml` | Manual/callable invalidation for app/branch |

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
- **Sample app content**: Add `/example1/main/index.html` etc. manually or via separate deploy script.
- **Observability**: CloudWatch alarms for Lambda@Edge errors, S3 access logging, CloudFront access logs.

---

## Commit Strategy (Atomic, Practical)

1. `chore: bootstrap project with ASDF, pnpm, and spec`
2. `feat(infra): add validation for branch and app names`
3. `feat(infra): add StaticHostingBucket construct`
4. `feat(infra): add SubdomainRoutingFunction construct` (incl. dev subdomain + branch routing)
5. `feat(infra): add closest-404 Lambda@Edge resolver`
6. `feat(infra): add SubdomainRoutingDistribution construct` (incl. cache policy, closest-404 behavior, SSM output)
7. `feat(infra): add HostingStack and wire constructs`
8. `feat(infra): add wildcard Route53 DNS records for distribution`
9. `chore(infra): apply tagging best practices to stack`
10. `ci: add validate-infra and deploy-infra workflows`
11. `ci: add invalidate-app workflow for CloudFront cache invalidation`
12. `ci: add reusable deploy-app workflow for app repos`
13. `ci: add cleanup-branch workflow for stale branch removal`
14. `ci: add cleanup-app workflow for app removal`
15. `docs: add configuration and deployment guide`

---

## Prerequisites (User Action)

- Create GitHub repo variable `AWS_AUTH_ROLE` with IAM role ARN (OIDC)
- Configure OIDC in AWS IAM for the repository (or use existing gha-aws-oidc pattern)
- Have Route53 hosted zone for `demo.oleksiipopov.com` (or adjust domain in config)
- Grant the OIDC role permissions: CloudFront, S3, SSM, Route53, ACM, Lambda, IAM (for Lambda@Edge execution role)
