# Static Hosting for Vibe Coders

Multi-app static hosting on AWS with branch preview URLs. One S3 bucket and one CloudFront distribution serve every app; each app repo deploys via a reusable GitHub Actions workflow.

Full specification: [docs/SPEC.md](docs/SPEC.md)

## Architecture

- **Production:** `{app}.{baseDomain}` → `s3://{bucket}/{app}/main/`
- **Branch preview:** `{app}--{branch}.dev.{baseDomain}` → `s3://{bucket}/{app}/{branch}/`
- **CloudFront Function** rewrites subdomain → S3 prefix (viewer-request)
- **Lambda@Edge** serves closest `404.html` for HTML navigation misses (origin-response)

## Prerequisites

### Local development

- [mise](https://mise.jdx.dev/) for Node.js 24 and pnpm
- AWS CLI (for deploy and smoke tests)
- AWS CDK CLI (installed via project dependencies)

```bash
mise trust    # first time only
mise install
pnpm install
```

### AWS (before first deploy)

1. **Route53 hosted zone** for your base domain (default: `demo.oleksiipopov.com`)
2. **GitHub OIDC** trust for this repository in AWS IAM
3. **GitHub repository variables:**
   - `AWS_AUTH_ROLE` — IAM role ARN for GitHub Actions (required)
   - `HOSTING_DOMAIN_NAME` — base domain (optional, default `demo.oleksiipopov.com`)
   - `HOSTING_MAIN_BRANCH` — production branch folder name (optional, default `main`)
   - `HOSTING_HOSTED_ZONE_ID` — Route53 zone ID (required for DNS records and ACM validation unless `HOSTING_CERTIFICATE_ARN` is set)
   - `HOSTING_HOSTED_ZONE_NAME` — Route53 zone apex name, e.g. `oleksiipopov.com` when `HOSTING_DOMAIN_NAME` is `demo.oleksiipopov.com` (defaults to `HOSTING_DOMAIN_NAME`)
   - `HOSTING_CERTIFICATE_ARN` — existing ACM cert ARN (optional; CDK creates one if omitted)
   - `HOSTING_ENVIRONMENT` — tag value (optional, default `production`)

4. **IAM permissions** for the OIDC role: CloudFront, S3, SSM, Route53, ACM, Lambda, IAM (for Lambda@Edge execution role)

## Deploy infrastructure

### Locally

```bash
export CDK_DEFAULT_ACCOUNT=<aws-account-id>
export CDK_DEFAULT_REGION=us-east-1
# Optional overrides:
# export HOSTING_DOMAIN_NAME=demo.oleksiipopov.com
# export HOSTING_HOSTED_ZONE_ID=Z1234567890ABC
# export HOSTING_HOSTED_ZONE_NAME=oleksiipopov.com

pnpm type-check
pnpm cdk:synth
pnpm cdk deploy --dir packages/infra --require-approval never
```

### Via GitHub Actions

Push to `main` (with changes under `packages/infra/`) or run **Deploy Infra** manually after configuring `AWS_AUTH_ROLE`.

## Validate locally

```bash
pnpm type-check
pnpm test
pnpm cdk:synth
pnpm validate:names --app my-app --branch feat/new-ui
```

## Connect an app repository

Add to your app repo `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]
  pull_request:

permissions:
  id-token: write
  contents: read
  pull-requests: write

jobs:
  deploy:
    uses: AlexeyPopovUA/static-hosting-for-vibe-coders/.github/workflows/deploy-app.yml@main
    with:
      app-slug: my-app
      build-command: pnpm build
      output-dir: dist
      base-domain: demo.oleksiipopov.com
    secrets: inherit
```

**Requirements:** App repos must use **pnpm**. On pull requests, the workflow posts a preview URL comment.

### Branch cleanup (optional)

```yaml
name: Cleanup

on:
  delete:
  pull_request:
    types: [closed]

permissions:
  id-token: write
  contents: read

jobs:
  cleanup:
    if: github.event_name == 'pull_request' || github.event.ref_type == 'branch'
    uses: AlexeyPopovUA/static-hosting-for-vibe-coders/.github/workflows/cleanup-branch.yml@main
    with:
      app-slug: my-app
      branch: ${{ github.event.ref_name || github.head_ref }}
    secrets: inherit
```

## Manual operations

| Workflow | Purpose |
|----------|---------|
| **Invalidate App Cache** | Bust CloudFront cache for an app or branch |
| **Cleanup App** | Remove all S3 files for an app (manual safety gate) |

## Smoke test checklist

After first deploy, CDK uploads two demo apps to S3:

| App | URL | Contents |
|-----|-----|----------|
| `hello` | `https://hello.{baseDomain}` | HTML + CSS |
| `palette` | `https://palette.{baseDomain}` | HTML + CSS + JS |

1. Open `https://hello.demo.oleksiipopov.com` — welcome page with link to palette
2. Open `https://palette.demo.oleksiipopov.com` — color swatches (click to copy hex)
3. Global fallback `404.html` is deployed automatically at the bucket root
4. Open a dev preview URL after deploying a branch via PR workflow

## Project layout

```
├── docs/SPEC.md              # Canonical specification
├── mise.toml                 # Node.js + pnpm versions
├── packages/infra/           # AWS CDK app
│   ├── assets/demo-apps/     # Sample hello + palette apps (deployed by CDK)
│   ├── src/config.ts         # Domain and environment config
│   ├── src/lib/validation.ts # App/branch name validation
│   └── src/functions/        # CloudFront Function + Lambda@Edge
└── .github/workflows/        # Infra CI + reusable app workflows
```

## SPA routing

For client-side routers, deploy `404.html` with the same content as `index.html` in each branch folder. The closest-404 resolver serves it for unmatched HTML paths.
